/**
 * Drive Embedder - Paste Choice Modal
 * Asks the user where a pasted image should go: Google Drive or the vault.
 */

import { App, Modal, Setting } from 'obsidian';

export type PasteChoice = 'drive' | 'vault' | 'cancel';

export class PasteChoiceModal extends Modal {
    private fileNames: string[];
    private resolveChoice: ((choice: PasteChoice) => void) | null = null;

    constructor(app: App, fileNames: string[]) {
        super(app);
        this.fileNames = fileNames;
    }

    /** Open the modal and resolve with the user's choice. Closing it counts as cancel. */
    choose(): Promise<PasteChoice> {
        return new Promise((resolve) => {
            this.resolveChoice = resolve;
            this.open();
        });
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('drive-embedder-paste-modal');

        const count = this.fileNames.length;
        this.setTitle(count === 1 ? 'Pasted image' : `Pasted ${count} images`);

        contentEl.createEl('p', {
            text: 'Upload to Google Drive and insert an embed, or save in the vault as usual?'
        });
        const list = contentEl.createEl('ul');
        this.fileNames.forEach(name => list.createEl('li', { text: name }));

        new Setting(contentEl)
            .addButton(button => button
                .setButtonText('Cancel')
                .onClick(() => this.finish('cancel'))
            )
            .addButton(button => button
                .setButtonText('Save in vault')
                .onClick(() => this.finish('vault'))
            )
            .addButton(button => button
                .setButtonText('Upload to Google Drive')
                .setCta()
                .onClick(() => this.finish('drive'))
            );
    }

    private finish(choice: PasteChoice) {
        this.settle(choice);
        this.close();
    }

    private settle(choice: PasteChoice) {
        const resolve = this.resolveChoice;
        this.resolveChoice = null;
        resolve?.(choice);
    }

    onClose() {
        // Esc or the close button: treat as cancel
        this.settle('cancel');
        this.contentEl.empty();
    }
}
