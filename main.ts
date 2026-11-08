/**
 * Drive Embedder - Main Plugin
 * Upload local files to Google Drive and embed them in Obsidian notes
 */

import { Plugin, PluginSettingTab, App, Setting, Notice, Editor, MarkdownView, MarkdownFileInfo } from 'obsidian';
import { DriveEmbedderSettings } from './src/types';
import { DEFAULT_SETTINGS } from './src/settings';
import { GoogleOAuthFlow } from './src/google-oauth-flow';
import { GoogleDriveUploader } from './src/uploader';
import { UploadModal, UploadModalResult } from './src/upload-modal';
import { EmbedGenerator } from './src/embed-generator';
import { PasteChoiceModal } from './src/paste-choice-modal';
import { getFileTypeInfo, getSizeById } from './src/size-presets';

// File extension for each image MIME type that Drive Embedder supports
const IMAGE_EXTENSIONS: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg'
};

export default class DriveEmbedderPlugin extends Plugin {
    settings: DriveEmbedderSettings;
    private oauthFlow: GoogleOAuthFlow | null = null;
    private uploader: GoogleDriveUploader | null = null;
    private embedGenerator: EmbedGenerator;

    async onload() {
        await this.loadSettings();

        this.embedGenerator = new EmbedGenerator();

        // Initialize OAuth and uploader if credentials exist
        this.initializeServices();

        // Add ribbon icon
        this.addRibbonIcon('cloud-upload', 'Drive Embedder: upload file', () => {
            this.openUploadModal();
        });

        // Add command
        this.addCommand({
            id: 'upload-and-embed',
            name: 'upload file and embed',
            editorCallback: (editor: Editor, view: MarkdownView) => {
                this.openUploadModal(editor);
            }
        });

        // Intercept pasted images (only when the setting is on)
        this.registerEvent(
            this.app.workspace.on('editor-paste', (evt, editor, info) => {
                this.handleEditorPaste(evt, editor, info);
            })
        );

        // Add settings tab
        this.addSettingTab(new DriveEmbedderSettingTab(this.app, this));

        console.debug('Drive Embedder loaded');
    }

    onunload() {
        console.debug('Drive Embedder unloaded');
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.initializeServices();
    }

    private initializeServices() {
        if (this.settings.googleClientId && this.settings.googleClientSecret) {
            this.oauthFlow = new GoogleOAuthFlow({
                clientId: this.settings.googleClientId,
                clientSecret: this.settings.googleClientSecret,
                redirectPort: 8586
            });

            if (this.settings.googleAccessToken) {
                this.uploader = new GoogleDriveUploader({
                    clientId: this.settings.googleClientId,
                    clientSecret: this.settings.googleClientSecret,
                    accessToken: this.settings.googleAccessToken,
                    refreshToken: this.settings.googleRefreshToken,
                    tokenExpiresAt: this.settings.tokenExpiresAt,
                    onTokenRefresh: async (tokens) => {
                        this.settings.googleAccessToken = tokens.accessToken;
                        this.settings.googleRefreshToken = tokens.refreshToken;
                        this.settings.tokenExpiresAt = tokens.expiresAt;
                        await this.saveSettings();
                    }
                });
            }
        }
    }

    async startOAuthFlow(): Promise<boolean> {
        if (!this.oauthFlow) {
            new Notice('please enter Google OAuth settings first.');
            return false;
        }

        try {
            const tokens = await this.oauthFlow.startOAuthFlow();

            this.settings.googleAccessToken = tokens.accessToken;
            this.settings.googleRefreshToken = tokens.refreshToken;
            this.settings.tokenExpiresAt = tokens.expiresAt;
            await this.saveSettings();

            new Notice('✅ connected to Google Drive successfully!');
            return true;
        } catch (error) {
            console.error('OAuth flow failed:', error);
            const message = error instanceof Error ? error.message : String(error);
            new Notice(`❌ connection failed: ${message}`);
            return false;
        }
    }

    async disconnectGoogleDrive() {
        this.settings.googleAccessToken = '';
        this.settings.googleRefreshToken = '';
        this.settings.tokenExpiresAt = 0;
        this.uploader = null;
        await this.saveSettings();
        new Notice('disconnected from Google Drive.');
    }

    isConnected(): boolean {
        return !!this.settings.googleAccessToken && !!this.uploader;
    }

    /**
     * Handle a paste in the editor. When the setting is on and the clipboard
     * holds image files, stop Obsidian's default paste and ask the user where
     * the images go: Google Drive (insert an embed) or the vault (insert a link).
     */
    private handleEditorPaste(evt: ClipboardEvent, editor: Editor, info: MarkdownView | MarkdownFileInfo) {
        if (!this.settings.uploadPastedImages || evt.defaultPrevented) return;
        if (!this.isConnected() || !this.uploader) return;

        const images = Array.from(evt.clipboardData?.files ?? [])
            .filter(file => file.type in IMAGE_EXTENSIONS);
        if (images.length === 0) return;

        evt.preventDefault();

        const files = images.map((file, i) => this.renamePastedImage(file, i));
        const sourcePath = info.file?.path ?? '';

        void (async () => {
            const choice = await new PasteChoiceModal(this.app, files.map(f => f.name)).choose();
            if (choice === 'drive') {
                for (const file of files) {
                    await this.uploadPastedImage(file, editor);
                }
            } else if (choice === 'vault') {
                await this.savePastedImagesInVault(files, editor, sourcePath);
            }
        })();
    }

    /** Give a clipboard image a unique name, like Obsidian does ("Pasted image 20261108140341.png"). */
    private renamePastedImage(file: File, index: number): File {
        const ext = IMAGE_EXTENSIONS[file.type];
        const suffix = index > 0 ? `-${index}` : '';
        const d = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
        const name = `Pasted image ${stamp}${suffix}${ext}`;
        return new File([file], name, { type: file.type, lastModified: file.lastModified });
    }

    /** Upload one pasted image to Google Drive and replace a placeholder in the note with its embed. */
    private async uploadPastedImage(file: File, editor: Editor) {
        if (!this.uploader) return;

        const placeholder = `![Uploading ${file.name}…]()`;
        editor.replaceSelection(placeholder);

        const notice = new Notice(`Uploading ${file.name}...`, 0);
        const result = await this.uploader.uploadFile(file, this.settings.driveFolder, (progress) => {
            notice.setMessage(`${file.name}: ${progress.message} ${Math.round(progress.progress)}%`);
        });
        notice.hide();

        const fileInfo = getFileTypeInfo(file.name);
        const embedCode = result && fileInfo
            ? this.embedGenerator.generateEmbed(file.name, result, {
                size: getSizeById(fileInfo.category, this.settings.defaultImageSize),
                showTitle: this.settings.showTitleByDefault
            })
            : '';

        if (!result) {
            new Notice(`❌ upload failed: ${file.name}. See the developer console for details.`);
        }

        // Swap the placeholder for the embed (or remove it on failure)
        const offset = editor.getValue().indexOf(placeholder);
        if (offset >= 0) {
            editor.replaceRange(
                embedCode,
                editor.offsetToPos(offset),
                editor.offsetToPos(offset + placeholder.length)
            );
        } else if (embedCode) {
            // The note changed during the upload and the placeholder is gone
            await navigator.clipboard.writeText(embedCode);
            new Notice('📋 embed code copied to clipboard!');
        }

        if (result) {
            new Notice(`✅ uploaded ${file.name} to Google Drive.`);
        }
    }

    /** Save pasted images as attachments in the vault and insert links, like Obsidian's default paste. */
    private async savePastedImagesInVault(files: File[], editor: Editor, sourcePath: string) {
        const links: string[] = [];
        for (const file of files) {
            const path = await this.app.fileManager.getAvailablePathForAttachment(file.name, sourcePath);
            const created = await this.app.vault.createBinary(path, await file.arrayBuffer());
            const link = this.app.fileManager.generateMarkdownLink(created, sourcePath);
            links.push(link.startsWith('!') ? link : `!${link}`);
        }
        editor.replaceSelection(links.join('\n'));
    }

    private openUploadModal(editor?: Editor) {
        if (!this.isConnected()) {
            new Notice('please connect to Google Drive first (in settings).');
            return;
        }

        if (!this.uploader) {
            new Notice('uploader initialization failed. please check settings.');
            return;
        }

        new UploadModal(
            this.app,
            this.uploader,
            this.settings.driveFolder,
            this.settings.showTitleByDefault,
            (result: UploadModalResult) => {
                void (async () => {
                    const embedCode = this.embedGenerator.generateEmbed(
                        result.file.name,
                        result.uploadResult,
                        result.embedOptions
                    );

                    if (editor) {
                        // Insert at cursor position
                        editor.replaceSelection(embedCode);
                    } else {
                        // Copy to clipboard
                        await navigator.clipboard.writeText(embedCode);
                        new Notice('📋 embed code copied to clipboard!');
                    }
                })();
            }
        ).open();
    }
}

class DriveEmbedderSettingTab extends PluginSettingTab {
    plugin: DriveEmbedderPlugin;

    constructor(app: App, plugin: DriveEmbedderPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        // Main heading removed per Obsidian guidelines (no plugin name in settings)

        // Connection status
        this.createConnectionSection(containerEl);

        // OAuth Settings
        this.createOAuthSection(containerEl);

        // Drive Settings
        this.createDriveSection(containerEl);

        // Embed Settings
        this.createEmbedSection(containerEl);

        // Help section
        this.createHelpSection(containerEl);
    }

    private createConnectionSection(containerEl: HTMLElement) {
        const connectionDiv = containerEl.createDiv({ cls: 'drive-embedder-connection-section' });

        const isConnected = this.plugin.isConnected();

        new Setting(connectionDiv)
            .setName('Connection status')
            .setHeading();

        const statusDiv = connectionDiv.createDiv({ cls: 'connection-status' });
        if (isConnected) {
            statusDiv.createSpan({ cls: 'status-connected', text: '✅ connected to Google Drive' });
        } else {
            statusDiv.createSpan({ cls: 'status-disconnected', text: '❌ not connected' });
        }

        if (isConnected) {
            new Setting(connectionDiv)
                .setName('Disconnect')
                .setDesc('disconnect from Google Drive')
                .addButton(button => button
                    .setButtonText('Disconnect')
                    .setWarning()
                    .onClick(() => {
                        void this.plugin.disconnectGoogleDrive().then(() => {
                            this.display();
                        });
                    })
                );
        } else {
            new Setting(connectionDiv)
                .setName('Connect to Google Drive')
                .setDesc('enter OAuth settings below, then click Connect')
                .addButton(button => button
                    .setButtonText('Connect')
                    .setCta()
                    .onClick(() => {
                        void this.plugin.startOAuthFlow().then((success) => {
                            if (success) {
                                this.display();
                            }
                        });
                    })
                );
        }
    }

    private createOAuthSection(containerEl: HTMLElement) {
        new Setting(containerEl)
            .setName('Google OAuth')
            .setHeading();

        new Setting(containerEl)
            .setName('Client ID')
            .setDesc('OAuth client ID from Google Cloud Console')
            .addText(text => text
                .setPlaceholder('xxx.apps.googleusercontent.com')
                .setValue(this.plugin.settings.googleClientId)
                .onChange((value) => {
                    this.plugin.settings.googleClientId = value;
                    void this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Client secret')
            .setDesc('OAuth client secret from Google Cloud Console')
            .addText(text => text
                .setPlaceholder('GOCSPX-...')
                .setValue(this.plugin.settings.googleClientSecret)
                .onChange((value) => {
                    this.plugin.settings.googleClientSecret = value;
                    void this.plugin.saveSettings();
                })
            );
    }

    private createDriveSection(containerEl: HTMLElement) {
        new Setting(containerEl)
            .setName('Google Drive')
            .setHeading();

        new Setting(containerEl)
            .setName('Upload folder')
            .setDesc('Google Drive folder path for uploaded files')
            .addText(text => text
                .setPlaceholder('Obsidian/DriveEmbedder')
                .setValue(this.plugin.settings.driveFolder)
                .onChange((value) => {
                    this.plugin.settings.driveFolder = value;
                    void this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Upload pasted images')
            .setDesc('when you paste an image into a note, ask whether to upload it to Google Drive or save it in the vault')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.uploadPastedImages)
                .onChange((value) => {
                    this.plugin.settings.uploadPastedImages = value;
                    void this.plugin.saveSettings();
                })
            );
    }

    private createEmbedSection(containerEl: HTMLElement) {
        new Setting(containerEl)
            .setName('Embed defaults')
            .setHeading();

        new Setting(containerEl)
            .setName('Show filename by default')
            .setDesc('display filename in embed code by default')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showTitleByDefault)
                .onChange((value) => {
                    this.plugin.settings.showTitleByDefault = value;
                    void this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Default theme')
            .setDesc('default embed theme (auto-detects system theme)')
            .addDropdown(dropdown => dropdown
                .addOption('auto', 'Auto (follows system)')
                .addOption('light', 'Light')
                .addOption('dark', 'Dark')
                .setValue(this.plugin.settings.defaultTheme)
                .onChange((value: 'auto' | 'light' | 'dark') => {
                    this.plugin.settings.defaultTheme = value;
                    void this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Default embed size')
            .setHeading();

        new Setting(containerEl)
            .setName('Default video size')
            .addDropdown(dropdown => dropdown
                .addOption('compact', 'Compact')
                .addOption('medium', 'Medium')
                .addOption('large', 'Large')
                .addOption('fullwidth', 'Full width')
                .setValue(this.plugin.settings.defaultVideoSize)
                .onChange((value) => {
                    this.plugin.settings.defaultVideoSize = value;
                    void this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Default audio size')
            .addDropdown(dropdown => dropdown
                .addOption('slim', 'Slim')
                .addOption('standard', 'Standard')
                .setValue(this.plugin.settings.defaultAudioSize)
                .onChange((value) => {
                    this.plugin.settings.defaultAudioSize = value;
                    void this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Default document size')
            .addDropdown(dropdown => dropdown
                .addOption('compact', 'Compact')
                .addOption('medium', 'Medium')
                .addOption('large', 'Large')
                .addOption('fullheight', 'Full height')
                .setValue(this.plugin.settings.defaultDocumentSize)
                .onChange((value) => {
                    this.plugin.settings.defaultDocumentSize = value;
                    void this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Default image size')
            .addDropdown(dropdown => dropdown
                .addOption('small', 'Small')
                .addOption('medium', 'Medium')
                .addOption('large', 'Large')
                .addOption('original', 'Original size')
                .setValue(this.plugin.settings.defaultImageSize)
                .onChange((value) => {
                    this.plugin.settings.defaultImageSize = value;
                    void this.plugin.saveSettings();
                })
            );
    }

    private createHelpSection(containerEl: HTMLElement) {
        new Setting(containerEl)
            .setName('Help')
            .setHeading();

        const helpDiv = containerEl.createDiv({ cls: 'drive-embedder-help' });

        // OAuth setup guide
        const oauthDetails = helpDiv.createEl('details');
        const oauthSummary = oauthDetails.createEl('summary');
        oauthSummary.createEl('strong', { text: '📋 how to set up Google OAuth' });
        const oauthList = oauthDetails.createEl('ol');
        const oauthStep1 = oauthList.createEl('li');
        oauthStep1.appendText('go to ');
        oauthStep1.createEl('a', { text: 'Google Cloud Console', href: 'https://console.cloud.google.com', attr: { target: '_blank' } });
        oauthList.createEl('li', { text: 'create a new project or select an existing one' });
        oauthList.createEl('li', { text: 'go to APIs & services → OAuth consent screen and configure' });
        oauthList.createEl('li', { text: 'go to APIs & services → Credentials → Create credentials → OAuth client ID' });
        oauthList.createEl('li', { text: 'select application type: desktop app' });
        oauthList.createEl('li', { text: 'enter the generated client ID and client secret in the settings above' });
        oauthList.createEl('li', { text: 'enable Google Drive API' });

        // Supported formats
        const formatsDetails = helpDiv.createEl('details');
        const formatsSummary = formatsDetails.createEl('summary');
        formatsSummary.createEl('strong', { text: '🎬 supported file formats' });
        const formatsList = formatsDetails.createEl('ul');
        const videoLi = formatsList.createEl('li');
        videoLi.createEl('strong', { text: 'Video: ' });
        videoLi.appendText('MP4, WebM, MOV, AVI');
        const audioLi = formatsList.createEl('li');
        audioLi.createEl('strong', { text: 'Audio: ' });
        audioLi.appendText('MP3, WAV, OGG, M4A');
        const docLi = formatsList.createEl('li');
        docLi.createEl('strong', { text: 'Document: ' });
        docLi.appendText('PDF');
        const imageLi = formatsList.createEl('li');
        imageLi.createEl('strong', { text: 'Image: ' });
        imageLi.appendText('JPG, PNG, GIF, WebP, SVG');

        // Size guide
        const sizeDetails = helpDiv.createEl('details');
        const sizeSummary = sizeDetails.createEl('summary');
        sizeSummary.createEl('strong', { text: '📐 embed size guide' });
        const sizeList = sizeDetails.createEl('ul');
        const compactLi = sizeList.createEl('li');
        compactLi.createEl('strong', { text: 'Compact: ' });
        compactLi.appendText('good size for inline content');
        const mediumLi = sizeList.createEl('li');
        mediumLi.createEl('strong', { text: 'Medium: ' });
        mediumLi.appendText('suitable for general viewing (recommended)');
        const largeLi = sizeList.createEl('li');
        largeLi.createEl('strong', { text: 'Large: ' });
        largeLi.appendText('when detailed view is needed');
        const fullLi = sizeList.createEl('li');
        fullLi.createEl('strong', { text: 'Full width: ' });
        fullLi.appendText('immersive full-width display');

        // How to use
        const howtoDetails = helpDiv.createEl('details');
        const howtoSummary = howtoDetails.createEl('summary');
        howtoSummary.createEl('strong', { text: '🔗 how to use' });
        const howtoList = howtoDetails.createEl('ol');
        howtoList.createEl('li', { text: 'click the cloud icon in the sidebar or search "Drive Embedder" in the command palette' });
        howtoList.createEl('li', { text: 'select a file (drag & drop or use the file picker button)' });
        howtoList.createEl('li', { text: 'choose your desired embed size' });
        howtoList.createEl('li', { text: 'click the "Upload and embed" button' });
        howtoList.createEl('li', { text: 'the embed code will be automatically inserted after upload' });
    }
}
