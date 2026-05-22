import * as vscode from 'vscode';

// ── Helpers ──────────────────────────────────────────────────────────────

type FimMode = 'auto' | 'codellama' | 'deepseek' | 'qwen' | 'starcoder' | 'none';

function getConfig() {
	const cfg = vscode.workspace.getConfiguration('ollamaCopilot');
	return {
		endpoint: cfg.get<string>('endpoint', 'http://localhost:11434'),
		model: cfg.get<string>('model', 'codellama'),
		debounce: cfg.get<number>('debounceMs', 300),
		maxTokens: cfg.get<number>('maxTokens', 128),
		temperature: cfg.get<number>('temperature', 0.1),
		fimMode: cfg.get<FimMode>('fimMode', 'auto'),
		prefixLines: cfg.get<number>('prefixLines', 60),
		suffixLines: cfg.get<number>('suffixLines', 20),
		prefixMaxChars: cfg.get<number>('prefixMaxChars', 4000),
		suffixMaxChars: cfg.get<number>('suffixMaxChars', 1000),
		useInfillEndpoint: cfg.get<boolean>('useInfillEndpoint', false),
		commitMaxDiffChars: cfg.get<number>('commitMaxDiffChars', 8000),
		commitMaxTokens: cfg.get<number>('commitMaxTokens', 200),
	};
}

// ── FIM templates ────────────────────────────────────────────────────────

interface FimTemplate {
	readonly pre: string;
	readonly suf: string;
	readonly mid: string;
	readonly stops: readonly string[];
}

const FIM_TEMPLATES: Record<Exclude<FimMode, 'auto'>, FimTemplate> = {
	codellama: { pre: '<PRE> ', suf: ' <SUF>', mid: ' <MID>', stops: ['<EOT>'] },
	deepseek: { pre: '<｜fim▁begin｜>', suf: '<｜fim▁hole｜>', mid: '<｜fim▁end｜>', stops: ['<｜end▁of▁sentence｜>'] },
	qwen: { pre: '<|fim_prefix|>', suf: '<|fim_suffix|>', mid: '<|fim_middle|>', stops: ['<|endoftext|>', '<|im_end|>', '<|fim_pad|>'] },
	starcoder: { pre: '<fim_prefix>', suf: '<fim_suffix>', mid: '<fim_middle>', stops: ['<|endoftext|>', '<file_sep>'] },
	none: { pre: '', suf: '', mid: '', stops: [] },
};

function resolveFimMode(mode: FimMode, modelName: string): Exclude<FimMode, 'auto'> {
	if (mode !== 'auto') { return mode; }
	const m = modelName.toLowerCase();
	if (m.includes('codellama') || m.includes('code-llama')) { return 'codellama'; }
	if (m.includes('deepseek')) { return 'deepseek'; }
	if (m.includes('qwen')) { return 'qwen'; }
	if (m.includes('starcoder') || m.includes('santacoder')) { return 'starcoder'; }
	return 'none';
}

function buildFimPrompt(prefix: string, suffix: string, template: FimTemplate, language: string): string {
	if (!template.pre) { return prefix; }
	console.log(language)
	return `${template.pre}// ${language}\n${prefix}${template.suf}${suffix}${template.mid}`;
}

// ── Context extraction ───────────────────────────────────────────────────

function extractContext(
	document: vscode.TextDocument,
	position: vscode.Position,
	prefixLines: number,
	suffixLines: number,
	prefixMaxChars: number,
	suffixMaxChars: number
): { prefix: string; suffix: string } {
	const startLine = Math.max(0, position.line - prefixLines);
	const endLine = Math.min(document.lineCount - 1, position.line + suffixLines);
	let prefix = document.getText(new vscode.Range(new vscode.Position(startLine, 0), position));
	const endChar = document.lineAt(endLine).text.length;
	let suffix = document.getText(new vscode.Range(position, new vscode.Position(endLine, endChar)));
	if (prefix.length > prefixMaxChars) { prefix = prefix.slice(prefix.length - prefixMaxChars); }
	if (suffix.length > suffixMaxChars) { suffix = suffix.slice(0, suffixMaxChars); }
	return { prefix, suffix };
}

// ── Cancellable delay ────────────────────────────────────────────────────

function cancellableDelay(ms: number, signal: AbortSignal): Promise<boolean> {
	return new Promise(resolve => {
		if (signal.aborted) { resolve(false); return; }
		const timer = setTimeout(() => resolve(true), ms);
		signal.addEventListener('abort', () => {
			clearTimeout(timer);
			resolve(false);
		}, { once: true });
	});
}

// ── Request ──────────────────────────────────────────────────────────────

async function queryLlama(
	endpoint: string,
	body: object,
	stops: string[],
	maxTokens: number,
	temperature: number,
	useInfill: boolean,
	signal: AbortSignal
): Promise<string | null> {
	const route = useInfill ? '/infill' : '/completion';
	const res = await fetch(`${endpoint}${route}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		signal,
		body: JSON.stringify({
			...body,
			n_predict: maxTokens,
			temperature,
			stop: stops,
			stream: false,
			cache_prompt: true,
			parse_special: true,
		}),
	});
	if (!res.ok) { return null; }
	const data = await res.json() as { content?: string };
	return data.content ?? null;
}

// ── Post-processing ──────────────────────────────────────────────────────

function postProcessSuggestion(raw: string, suffix: string, stops: readonly string[]): string {
	let out = raw;
	for (const stop of stops) {
		const idx = out.indexOf(stop);
		if (idx !== -1) { out = out.slice(0, idx); }
	}
	out = out.replace(/\s+$/, '');
	// Trim any tail that already exists right after the cursor (avoids duplicating existing code).
	const suffixHead = suffix.slice(0, 200);
	if (suffixHead) {
		for (let len = Math.min(out.length, suffixHead.length); len > 8; len--) {
			if (out.endsWith(suffixHead.slice(0, len))) {
				out = out.slice(0, -len).replace(/\s+$/, '');
				break;
			}
		}
	}
	return out;
}

// ── Commit message generation ────────────────────────────────────────────

interface GitInputBox { value: string }
interface GitRepository {
	readonly rootUri: vscode.Uri;
	readonly inputBox: GitInputBox;
	diff(cached?: boolean): Promise<string>;
}
interface GitAPI {
	readonly repositories: GitRepository[];
	getRepository(uri: vscode.Uri): GitRepository | null;
}
interface GitExtensionExports {
	getAPI(version: 1): GitAPI;
}

async function getGitAPI(): Promise<GitAPI | null> {
	const ext = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
	if (!ext) { return null; }
	const exports = ext.isActive ? ext.exports : await ext.activate();
	return exports.getAPI(1);
}

async function pickRepository(api: GitAPI, sourceControl?: vscode.SourceControl): Promise<GitRepository | null> {
	if (sourceControl?.rootUri) {
		const match = api.getRepository(sourceControl.rootUri);
		if (match) { return match; }
	}
	if (api.repositories.length === 1) { return api.repositories[0]; }
	if (api.repositories.length === 0) { return null; }
	const pick = await vscode.window.showQuickPick(
		api.repositories.map(r => ({ label: r.rootUri.fsPath, repo: r })),
		{ placeHolder: 'Select repository' }
	);
	return pick?.repo ?? null;
}

function buildCommitPrompt(diff: string, maxDiffChars: number): string {
	const truncated = diff.length > maxDiffChars
		? diff.slice(0, maxDiffChars) + '\n…[diff truncated]'
		: diff;
	return [
		'### Instruction:',
		'Write a single concise git commit message for the diff below.',
		'Use Conventional Commits format: type(scope): short summary.',
		'Respond with the trimmed commit message only, no explanations or code fences.',
		'',
		'### Diff:',
		truncated,
		'',
		'### Commit message:',
		''
	].join('\n');
}

function cleanCommitMessage(raw: string): string {
	let msg = raw.trim();
	// Strip fenced code blocks if the model added them anyway.
	const fenced = msg.match(/^```(?:\w+)?\n([\s\S]*?)\n```$/);
	if (fenced) { msg = fenced[1].trim(); }
	// Drop trailing instruction-style sections the model may emit.
	const cut = msg.search(/\n###\s/);
	if (cut !== -1) { msg = msg.slice(0, cut).trim(); }
	return msg;
}

async function requestCommitMessage(diff: string, token: vscode.CancellationToken): Promise<string | null> {
	const { endpoint, commitMaxDiffChars } = getConfig();
	const controller = new AbortController();
	token.onCancellationRequested(() => controller.abort());

	const res = await fetch(`${endpoint}/completion`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		signal: controller.signal,
		body: JSON.stringify({
			prompt: buildCommitPrompt(diff, commitMaxDiffChars),
			n_predict: 64,
			temperature: 0.1,
			stop: ['\n']
		}),
	});

	if (!res.ok) {
		throw new Error(`llama.cpp ${res.status} ${res.statusText}`);
	}
	const data = await res.json() as { content?: string };
	const content = data.content;
	if (!content) { return null; }
	const cleaned = cleanCommitMessage(content);
	return cleaned.length ? cleaned : null;
}

async function generateCommitMessageCommand(sourceControl?: vscode.SourceControl): Promise<void> {
	const api = await getGitAPI();
	if (!api) {
		vscode.window.showErrorMessage('Git extension is not available.');
		return;
	}
	const repo = await pickRepository(api, sourceControl);
	if (!repo) {
		vscode.window.showErrorMessage('No git repository found.');
		return;
	}

	let diff = await repo.diff(true);
	let usedStaged = true;
	if (!diff.trim()) {
		diff = await repo.diff(false);
		usedStaged = false;
	}
	if (!diff.trim()) {
		vscode.window.showWarningMessage('No changes to summarize.');
		return;
	}

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.SourceControl,
			title: usedStaged ? 'Generating commit message…' : 'Generating commit message (unstaged)…',
			cancellable: true,
		},
		async (_progress, token) => {
			try {
				const message = await requestCommitMessage(diff, token);
				if (token.isCancellationRequested) { return; }
				if (!message) {
					vscode.window.showWarningMessage('Model returned an empty commit message.');
					return;
				}
				repo.inputBox.value = message;
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				vscode.window.showErrorMessage(`Commit message generation failed: ${detail}`);
			}
		}
	);
}

// ── Provider ─────────────────────────────────────────────────────────────

class OllamaInlineProvider implements vscode.InlineCompletionItemProvider {
	private readonly _inFlight = new Map<string, AbortController>();

	async provideInlineCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		context: vscode.InlineCompletionContext,
		token: vscode.CancellationToken
	): Promise<vscode.InlineCompletionList | null> {
		const cfg = getConfig();
		const key = document.uri.toString();

		// Cancel any prior in-flight request for this document.
		this._inFlight.get(key)?.abort();
		const controller = new AbortController();
		this._inFlight.set(key, controller);
		const cancelSub = token.onCancellationRequested(() => controller.abort());
		const language = document.languageId;

		try {
			// Don't suggest in the middle of a word — the model would compete with the user's typing.
			const lineText = document.lineAt(position.line).text;
			if (/^\w/.test(lineText.slice(position.character))) { return null; }

			const isAutomatic = context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic;
			if (isAutomatic) {
				const fired = await cancellableDelay(cfg.debounce, controller.signal);
				if (!fired) { return null; }
			}

			const { prefix, suffix } = extractContext(
				document, position,
				cfg.prefixLines, cfg.suffixLines,
				cfg.prefixMaxChars, cfg.suffixMaxChars
			);

			// Skip empty automatic invocations — explicit Ctrl+Space still fires.
			if (isAutomatic && prefix.trim().length === 0) { return null; }

			const mode = resolveFimMode(cfg.fimMode, cfg.model);
			const template = FIM_TEMPLATES[mode];
			const stops = ['\n\n\n', ...template.stops];

			const body: object = cfg.useInfillEndpoint
				? { input_prefix: prefix, input_suffix: suffix }
				: { prompt: buildFimPrompt(prefix, suffix, template, language) };

			const raw = await queryLlama(
				cfg.endpoint, body, stops,
				cfg.maxTokens, cfg.temperature, cfg.useInfillEndpoint,
				controller.signal
			);
			if (controller.signal.aborted || raw === null) { return null; }

			const cleaned = postProcessSuggestion(raw, suffix, template.stops);
			if (!cleaned.trim()) { return null; }

			return {
				items: [
					new vscode.InlineCompletionItem(cleaned, new vscode.Range(position, position))
				]
			};
		} catch (err) {
			if ((err as { name?: string }).name === 'AbortError') { return null; }
			console.warn('Ollama Copilot:', err);
			return null;
		} finally {
			cancelSub.dispose();
			if (this._inFlight.get(key) === controller) {
				this._inFlight.delete(key);
			}
		}
	}
}

// ── Activación ────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
	const provider = new OllamaInlineProvider();

	// Registrar para TODOS los lenguajes
	const selector: vscode.DocumentSelector = { pattern: '**' };

	context.subscriptions.push(
		vscode.languages.registerInlineCompletionItemProvider(selector, provider)
	);

	// Comando: generar mensaje de commit
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'ollamaCopilot.generateCommitMessage',
			(sourceControl?: vscode.SourceControl) => generateCommitMessageCommand(sourceControl)
		)
	);

	// Comando para cambiar modelo rápido
	context.subscriptions.push(
		vscode.commands.registerCommand('ollamaCopilot.switchModel', async () => {
			const model = await vscode.window.showInputBox({
				prompt: 'Nombre del modelo Ollama',
				value: getConfig().model,
			});
			if (model) {
				await vscode.workspace.getConfiguration('ollamaCopilot').update(
					'model', model, vscode.ConfigurationTarget.Global
				);
				vscode.window.showInformationMessage(`Ollama Copilot: modelo cambiado a "${model}"`);
			}
		})
	);

	console.log('Ollama Copilot activo');
}

export function deactivate() { }
