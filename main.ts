import { App, Editor, MarkdownView, Modal, Notice, Platform, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { setIntervalAsync, clearIntervalAsync } from 'set-interval-async';

type NoticeLevelSetting = 'ALL' | 'WARNING' | 'ERROR';
type LegacyNoticeLevelSetting = NoticeLevelSetting | 'WARNINGS';
type NoticeSeverity = 'INFO' | 'WARNING' | 'ERROR';


interface GHSyncSettings {
	remoteURL: string;
	githubToken: string;
	syncinterval: number;
	isSyncOnLoad: boolean;
	checkStatusOnLoad: boolean;
	noticeLevel: NoticeLevelSetting;
	showSyncSuccessNotice: boolean;
}

const DEFAULT_SETTINGS: GHSyncSettings = {
	remoteURL: '',
	githubToken: '',
	syncinterval: 0,
	isSyncOnLoad: false,
	checkStatusOnLoad: true,
	noticeLevel: 'ALL',
	showSyncSuccessNotice: true,
}

function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
	const normalized = url.trim().replace(/\/+$/, '');
	const https = normalized.match(/github\.com\/([^\/]+)\/([^\/]+?)(?:\.git)?$/);
	if (https) return { owner: https[1], repo: https[2] };
	const ssh = normalized.match(/github\.com:([^\/]+)\/([^\/]+?)(?:\.git)?$/);
	if (ssh) return { owner: ssh[1], repo: ssh[2] };
	const sshWithProtocol = normalized.match(/ssh:\/\/git@github\.com\/([^\/]+)\/([^\/]+?)(?:\.git)?$/);
	if (sshWithProtocol) return { owner: sshWithProtocol[1], repo: sshWithProtocol[2] };
	return null;
}

function encodeBase64Content(bytes: Uint8Array): string {
	const chunkSize = 0x4000;
	const binaryChunks: string[] = [];
	for (let i = 0; i < bytes.length; i += chunkSize) {
		const chunk = bytes.subarray(i, i + chunkSize);
		const chars = new Array(chunk.length);
		for (let j = 0; j < chunk.length; j++) {
			chars[j] = String.fromCharCode(chunk[j]);
		}
		binaryChunks.push(chars.join(''));
	}
	return btoa(binaryChunks.join(''));
}

async function githubRequest(token: string, method: string, url: string, body?: object): Promise<any> {
	const resp = await fetch(url, {
		method,
		headers: {
			'Authorization': 'token ' + token,
			'Accept': 'application/vnd.github+json',
			'Content-Type': 'application/json',
			'X-GitHub-Api-Version': '2022-11-28'
		},
		body: body ? JSON.stringify(body) : undefined
	});
	if (resp.status === 404 && method === 'GET') return null;
	if (!resp.ok) {
		const err = await resp.text();
		throw new Error(`GitHub API error ${resp.status}: ${err}`);
	}
	// 204 No Content
	if (resp.status === 204) return null;
	return resp.json();
}

function buildContentsApiUrl(owner: string, repo: string, path: string): string {
	const encodedPath = path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
	return `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`;
}

async function getRemoteBase64(token: string, owner: string, repo: string, remoteFile: any): Promise<string> {
	if (typeof remoteFile.content === 'string') {
		return remoteFile.content.replace(/\n/g, '');
	}

	if (!remoteFile.sha) {
		throw new Error('GitHub Sync: Remote file content is unavailable.');
	}

	const blob = await githubRequest(token, 'GET', `https://api.github.com/repos/${owner}/${repo}/git/blobs/${remoteFile.sha}`);
	if (!blob || typeof blob.content !== 'string') {
		throw new Error('GitHub Sync: Failed to load remote file content.');
	}

	return blob.content.replace(/\n/g, '');
}

async function listRemoteFilePaths(token: string, owner: string, repo: string): Promise<string[]> {
	const repoData = await githubRequest(token, 'GET', `https://api.github.com/repos/${owner}/${repo}`);
	if (!repoData) return [];
	const ref = await githubRequest(token, 'GET', `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${repoData.default_branch}`);
	if (!ref || !ref.object) return [];
	const commit = await githubRequest(token, 'GET', `https://api.github.com/repos/${owner}/${repo}/git/commits/${ref.object.sha}`);
	if (!commit || !commit.tree) return [];
	const tree = await githubRequest(token, 'GET', `https://api.github.com/repos/${owner}/${repo}/git/trees/${commit.tree.sha}?recursive=1`);
	if (!tree || !tree.tree) return [];
	return tree.tree.filter((item: any) => item.type === 'blob').map((item: any) => item.path as string);
}

export default class GHSyncPlugin extends Plugin {

	settings: GHSyncSettings;

	private shouldShowNotice(severity: NoticeSeverity): boolean {
		switch (this.settings.noticeLevel) {
			case 'ERROR':
				return severity === 'ERROR';
			case 'WARNING':
				return severity === 'WARNING' || severity === 'ERROR';
			case 'ALL':
			default:
				return true;
		}
	}

	private showNotice(message: unknown, severity: NoticeSeverity, timeout?: number): void {
		if (!this.shouldShowNotice(severity)) {
			return;
		}

		const text = message instanceof Error ? message.message : String(message);
		new Notice(text, timeout);
	}

	private showSyncSuccessNotice(): void {
		if (!this.settings.showSyncSuccessNotice) {
			return;
		}

		this.showNotice('github sync successful', 'INFO');
	}

	async SyncNotes()
	{
		const remote = this.settings.remoteURL.trim();
		const token = this.settings.githubToken.trim();

		if (!remote || !token) {
			this.showNotice("GitHub Sync: Remote URL and GitHub Token are required.", 'ERROR', 10000);
			return;
		}

		const parsed = parseGitHubUrl(remote);
		if (!parsed) {
			this.showNotice("GitHub Sync: Could not parse owner/repo from Remote URL.", 'ERROR', 10000);
			return;
		}
		const { owner, repo } = parsed;

		const hostname = Platform.isMobileApp ? "mobile" : "desktop";
		const date = new Date();
		const msg = `${hostname} ${date.getFullYear()}-${date.getMonth()+1}-${date.getDate()}:${date.getHours()}:${date.getMinutes()}:${date.getSeconds()}`;

		const files = this.app.vault.getFiles();
		const localFilePaths = new Set(files.map(f => f.path));
		const updatedFromRemote: string[] = [];

		for (const file of files) {
			const fileData = await this.app.vault.readBinary(file);
			const localBase64 = encodeBase64Content(new Uint8Array(fileData));

			let remoteFile: any = null;
			try {
				remoteFile = await githubRequest(token, 'GET', buildContentsApiUrl(owner, repo, file.path));
			} catch (e) {
				this.showNotice(e, 'ERROR', 10000);
				return;
			}

			if (remoteFile) {
				let remoteBase64: string;
				try {
					remoteBase64 = await getRemoteBase64(token, owner, repo, remoteFile);
				} catch (e) {
					this.showNotice(e, 'ERROR', 10000);
					return;
				}

				if (remoteBase64 === localBase64) {
					// No changes, skip
					continue;
				}

				// Local and remote differ — local wins, push local content to remote
				this.showNotice(`GitHub Sync: WARNING – overwriting remote changes with local version for: ${file.path}`, 'WARNING', 10000);
				try {
					await githubRequest(token, 'PUT', buildContentsApiUrl(owner, repo, file.path), {
						message: msg,
						content: localBase64,
						sha: remoteFile.sha,
					});
				} catch (e) {
					this.showNotice(e, 'ERROR', 10000);
					return;
				}
				continue;
			}

			// File doesn't exist on remote — create it
			try {
				await githubRequest(token, 'PUT', buildContentsApiUrl(owner, repo, file.path), {
					message: msg,
					content: localBase64,
				});
			} catch (e) {
				this.showNotice(e, 'ERROR', 10000);
				return;
			}
		}

		// Download remote files that don't exist locally
		let remoteFilePaths: string[] = [];
		try {
			remoteFilePaths = await listRemoteFilePaths(token, owner, repo);
		} catch (e) {
			this.showNotice(e, 'ERROR', 10000);
			return;
		}

		for (const remotePath of remoteFilePaths) {
			if (localFilePaths.has(remotePath)) continue;
			try {
				const remoteFile = await githubRequest(token, 'GET', buildContentsApiUrl(owner, repo, remotePath));
				if (!remoteFile) continue;
				const remoteBase64 = await getRemoteBase64(token, owner, repo, remoteFile);
				const binary = atob(remoteBase64);
				const bytes = new Uint8Array(binary.length);
				for (let i = 0; i < binary.length; i++) {
					bytes[i] = binary.charCodeAt(i);
				}
				const lastSlash = remotePath.lastIndexOf('/');
				const dirPath = lastSlash >= 0 ? remotePath.substring(0, lastSlash) : '';
				if (dirPath) {
					// createFolder throws if the folder already exists; suppress that error
					await this.app.vault.createFolder(dirPath).catch(() => {});
				}
				await this.app.vault.createBinary(remotePath, bytes.buffer);
				updatedFromRemote.push(remotePath);
			} catch (e) {
				this.showNotice(e, 'ERROR', 10000);
				return;
			}
		}

		if (updatedFromRemote.length > 0) {
			const updateMsg = `GitHub Sync: Updated from remote:\n\t${updatedFromRemote.join('\n\t')}`;
			this.showNotice(updateMsg, 'INFO');
			return;
		}

		this.showSyncSuccessNotice();
	}

	async CheckStatusOnStart()
	{
		try {
			const remote = this.settings.remoteURL.trim();
			const token = this.settings.githubToken.trim();

			if (!remote || !token) {
				return;
			}

			const parsed = parseGitHubUrl(remote);
			if (!parsed) {
				return;
			}
			const { owner, repo } = parsed;

			const files = this.app.vault.getFiles();
			const localFilePaths = new Set(files.map(f => f.path));
			// 'behind' means the vault is out of sync with remote in any direction
			let behind = false;

			for (const file of files) {
				const remoteFile = await githubRequest(token, 'GET', buildContentsApiUrl(owner, repo, file.path));

				if (remoteFile) {
					const fileData = await this.app.vault.readBinary(file);
					const localBase64 = encodeBase64Content(new Uint8Array(fileData));
					const remoteBase64 = await getRemoteBase64(token, owner, repo, remoteFile);
					if (remoteBase64 !== localBase64) {
						behind = true;
						break;
					}
				} else {
					behind = true;
					break;
				}
			}

			if (!behind) {
				// Also check whether remote has files not present locally
				const remoteFilePaths = await listRemoteFilePaths(token, owner, repo);
				for (const remotePath of remoteFilePaths) {
					if (!localFilePaths.has(remotePath)) {
						behind = true;
						break;
					}
				}
			}

			if (behind) {
				if (this.settings.isSyncOnLoad) {
					await this.SyncNotes();
				} else {
					this.showNotice("GitHub Sync: vault content differs from remote.\nClick the GitHub ribbon icon to sync.", 'WARNING');
				}
			} else {
				this.showNotice("GitHub Sync: up to date with remote.", 'INFO');
			}
		} catch (e) {
			// don't care
		}
	}

	async onload() {
		await this.loadSettings();

		const ribbonIconEl = this.addRibbonIcon('github', 'Sync with Remote', (evt: MouseEvent) => {
			this.SyncNotes();
		});
		ribbonIconEl.addClass('gh-sync-ribbon');

		this.addCommand({
			id: 'github-sync-command',
			name: 'Sync with Remote',
			callback: () => {
				this.SyncNotes();
			}
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new GHSyncSettingTab(this.app, this));

		if (!isNaN(this.settings.syncinterval))
		{
			let interval: number = this.settings.syncinterval;
			if (interval >= 1)
			{
				try {
					setIntervalAsync(async () => {
						await this.SyncNotes();
					}, interval * 60 * 1000);
					//this.registerInterval(setInterval(this.SyncNotes, interval * 6 * 1000));
					this.showNotice("Auto sync enabled", 'INFO');
				} catch (e) {
					
				}
			}
		}

		if (this.settings.checkStatusOnLoad)
		{
			this.CheckStatusOnStart();
		}
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

		if ((this.settings.noticeLevel as LegacyNoticeLevelSetting) === 'WARNINGS') {
			this.settings.noticeLevel = 'WARNING';
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class GHSyncSettingTab extends PluginSettingTab {
	plugin: GHSyncPlugin;

	constructor(app: App, plugin: GHSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		const howto = containerEl.createEl("div", { cls: "howto" });
		howto.createEl("div", { text: "How to use this plugin", cls: "howto_title" });
		howto.createEl("small", { text: "Grab your GitHub repository's HTTPS url and paste it into the settings here. Create a GitHub Personal Access Token with 'repo' scope and paste it in the token field below.", cls: "howto_text" });
		howto.createEl("br");
        const linkEl = howto.createEl('p');
        linkEl.createEl('span', { text: 'See the ' });
        linkEl.createEl('a', { href: 'https://github.com/kevinmkchin/Obsidian-GitHub-Sync/blob/main/README.md', text: 'README' });
        linkEl.createEl('span', { text: ' for more information and troubleshooting.' });

		new Setting(containerEl)
			.setName('Remote URL')
			.setDesc('')
			.addText(text => text
				.setPlaceholder('')
				.setValue(this.plugin.settings.remoteURL)
				.onChange(async (value) => {
					this.plugin.settings.remoteURL = value;
					await this.plugin.saveSettings();
				})
        	.inputEl.addClass('my-plugin-setting-text'));

		new Setting(containerEl)
			.setName('GitHub Personal Access Token')
			.setDesc('Required for authentication. Create a token at github.com → Settings → Developer settings → Personal access tokens. Token needs "repo" scope. Note: this token is stored in plain text on disk and is not encrypted by Obsidian.')
			.addText(text => {
				text
					.setPlaceholder('ghp_...')
					.setValue(this.plugin.settings.githubToken)
					.onChange(async (value) => {
						this.plugin.settings.githubToken = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.type = 'password';
				text.inputEl.autocomplete = 'off';
			});

		new Setting(containerEl)
			.setName('Notice level')
			.setDesc('Choose which GitHub Sync notices are shown in the Obsidian UI.')
			.addDropdown((dropdown) => dropdown
				.addOption('ALL', 'ALL')
				.addOption('WARNING', 'WARNING')
				.addOption('ERROR', 'ERROR')
				.setValue(this.plugin.settings.noticeLevel)
				.onChange(async (value: NoticeLevelSetting) => {
					this.plugin.settings.noticeLevel = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Hide Success Message')
			.setDesc('Hide the single success notice shown when a sync finishes successfully.')
			.addToggle((toggle) => toggle
				.setValue(!this.plugin.settings.showSyncSuccessNotice)
				.onChange(async (value) => {
					this.plugin.settings.showSyncSuccessNotice = !value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Check status on startup')
			.setDesc('Check to see if you are behind remote when you start Obsidian.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.checkStatusOnLoad)
				.onChange(async (value) => {
					this.plugin.settings.checkStatusOnLoad = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Auto sync on startup')
			.setDesc('Automatically sync with remote when you start Obsidian if there are unsynced changes.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.isSyncOnLoad)
				.onChange(async (value) => {
					this.plugin.settings.isSyncOnLoad = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Auto sync at interval')
			.setDesc('Set minute interval after which your vault is synced automatically. Auto sync is disabled if this field is left empty or not a positive integer. Restart Obsidan to take effect.')
			.addText(text => text
				.setValue(String(this.plugin.settings.syncinterval))
				.onChange(async (value) => {
					this.plugin.settings.syncinterval = Number(value);
					await this.plugin.saveSettings();
				}));
	}
}
