/**
 * Drive Embedder - Type Definitions
 */

// Content categories for size presets
export type ContentCategory = 'video' | 'document' | 'image' | 'audio';

// Supported file types
export interface SupportedFileType {
    extension: string;
    mimeType: string;
    category: ContentCategory;
    icon: string;
    label: string;
}

// Size option for embed
export interface SizeOption {
    id: string;
    label: string;
    icon: string;
    description: string;
    width: string;
    height: string;
    recommended?: boolean;
}

// Upload result from Google Drive
export interface DriveUploadResult {
    fileId: string;
    webViewLink: string;
    webContentLink: string;
    fileName: string;
    mimeType: string;
}

// Embed options for generating code
export interface EmbedOptions {
    size: SizeOption;
    showTitle: boolean;
}

// Upload progress callback
export interface UploadProgress {
    stage: 'preparing' | 'uploading' | 'setting-permission' | 'complete' | 'error';
    message: string;
    progress: number; // 0-100
    error?: string;
}

// OAuth tokens
export interface OAuthTokens {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    expiresAt: number;
}

// Plugin settings
export interface DriveEmbedderSettings {
    // Google OAuth
    googleClientId: string;
    googleClientSecret: string;
    googleAccessToken: string;
    googleRefreshToken: string;
    tokenExpiresAt: number;

    // Drive settings
    driveFolder: string;

    // Clipboard: intercept pasted images and offer to upload them to Google Drive
    uploadPastedImages: boolean;

    // Embed settings
    showTitleByDefault: boolean;
    defaultTheme: 'light' | 'dark' | 'auto';

    // Default sizes per category
    defaultVideoSize: string;
    defaultDocumentSize: string;
    defaultImageSize: string;
    defaultAudioSize: string;
}

// Modal result
export interface UploadModalResult {
    file: File;
    category: ContentCategory;
    sizeOption: SizeOption;
    title: string;
    showTitle: boolean;
}
