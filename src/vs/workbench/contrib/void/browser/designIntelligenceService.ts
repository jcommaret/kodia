/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import {
	BrandSystemProfile,
	BrowserVisualAuditResult,
	ColorPaletteSpec,
	DesignBrief,
	DesignConsistencyAuditReport,
	DesignCritiqueReport,
	DesignTokensSpec,
	DownloadedVisualAsset,
	ExistingDesignSystemReport,
	MultiViewportAuditResult,
	PageArchitectureSpec,
	ProductDesignAnalysis,
	VisualAssetCandidate,
	VisualDirectionSpec,
	VisualRevisionComparison,
} from '../common/designIntelligenceTypes.js';

export const DESIGN_SYSTEM_WORKSPACE_FILE = '.kodia/design-system.json';
const DESIGN_STATE_STORAGE_KEY = 'kodia.designIntelligence.state.v1';

export interface ScreenshotRevisionEntry {
	readonly id: string;
	readonly label: string;
	readonly url: string;
	readonly width: number;
	readonly height: number;
	readonly path: string;
	readonly dataUrl?: string;
	readonly capturedAt: string;
}

export interface ProjectDesignState {
	readonly brandProfile: BrandSystemProfile | null;
	readonly latestAnalysis: ProductDesignAnalysis | null;
	readonly latestBrief: DesignBrief | null;
	readonly latestDirection: VisualDirectionSpec | null;
	readonly latestPalette: ColorPaletteSpec | null;
	readonly latestTokens: DesignTokensSpec | null;
	readonly latestArchitecture: PageArchitectureSpec | null;
	readonly latestExistingSystem: ExistingDesignSystemReport | null;
	readonly latestConsistencyAudit: DesignConsistencyAuditReport | null;
	readonly latestVisualAudit: BrowserVisualAuditResult | null;
	readonly latestMultiViewport: MultiViewportAuditResult | null;
	readonly latestCritique: DesignCritiqueReport | null;
	readonly latestComparison: VisualRevisionComparison | null;
	readonly discoveredAssets: readonly VisualAssetCandidate[];
	readonly downloadedAssets: readonly DownloadedVisualAsset[];
	readonly screenshotRevisions: readonly ScreenshotRevisionEntry[];
}

export interface IDesignIntelligenceService {
	readonly _serviceBrand: undefined;
	readonly state: ProjectDesignState;
	readonly onDidChange: Event<void>;

	getBrandProfile(): BrandSystemProfile | null;
	saveBrandProfile(profile: Omit<BrandSystemProfile, 'updatedAt'>): Promise<BrandSystemProfile>;
	clearBrandProfile(): Promise<void>;

	recordAnalysis(analysis: ProductDesignAnalysis): void;
	recordBrief(brief: DesignBrief): void;
	recordDirection(direction: VisualDirectionSpec): void;
	recordPalette(palette: ColorPaletteSpec): void;
	recordTokens(tokens: DesignTokensSpec): void;
	recordArchitecture(arch: PageArchitectureSpec): void;
	recordExistingSystem(report: ExistingDesignSystemReport): void;
	recordConsistencyAudit(report: DesignConsistencyAuditReport): void;
	recordVisualAudit(audit: BrowserVisualAuditResult): void;
	recordMultiViewportAudit(result: MultiViewportAuditResult): void;
	recordCritique(critique: DesignCritiqueReport): void;
	recordComparison(comparison: VisualRevisionComparison): void;
	recordDiscoveredAssets(assets: readonly VisualAssetCandidate[]): void;
	recordDownloadedAssets(assets: readonly DownloadedVisualAsset[]): void;
	recordScreenshotRevision(entry: Omit<ScreenshotRevisionEntry, 'id' | 'capturedAt'>): ScreenshotRevisionEntry;

	formatBrandGuidelinesForPrompt(): string;
}

export const IDesignIntelligenceService = createDecorator<IDesignIntelligenceService>('kodiaDesignIntelligenceService');

const EMPTY_STATE: ProjectDesignState = {
	brandProfile: null,
	latestAnalysis: null,
	latestBrief: null,
	latestDirection: null,
	latestPalette: null,
	latestTokens: null,
	latestArchitecture: null,
	latestExistingSystem: null,
	latestConsistencyAudit: null,
	latestVisualAudit: null,
	latestMultiViewport: null,
	latestCritique: null,
	latestComparison: null,
	discoveredAssets: [],
	downloadedAssets: [],
	screenshotRevisions: [],
};

export class DesignIntelligenceService extends Disposable implements IDesignIntelligenceService {
	readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private _state: ProjectDesignState = { ...EMPTY_STATE };

	get state(): ProjectDesignState {
		return this._state;
	}

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
	) {
		super();
		this._loadFromStorage();
		void this._loadBrandFileFromWorkspace();
	}

	private _getDesignSystemFileUri(): URI | null {
		const folder = this._workspaceContextService.getWorkspace().folders[0];
		if (!folder) { return null; }
		return URI.joinPath(folder.uri, '.kodia', 'design-system.json');
	}

	private _loadFromStorage(): void {
		try {
			const raw = this._storageService.get(DESIGN_STATE_STORAGE_KEY, StorageScope.WORKSPACE);
			if (!raw) { return; }
			const parsed = JSON.parse(raw) as Partial<ProjectDesignState>;
			if (parsed && typeof parsed === 'object') {
				this._state = {
					...EMPTY_STATE,
					...parsed,
					discoveredAssets: Array.isArray(parsed.discoveredAssets) ? parsed.discoveredAssets : [],
					downloadedAssets: Array.isArray(parsed.downloadedAssets) ? parsed.downloadedAssets : [],
					screenshotRevisions: Array.isArray(parsed.screenshotRevisions) ? parsed.screenshotRevisions : [],
				};
			}
		} catch { /* ignore corrupted storage */ }
	}

	private async _loadBrandFileFromWorkspace(): Promise<void> {
		const uri = this._getDesignSystemFileUri();
		if (!uri) { return; }
		try {
			const file = await this._fileService.readFile(uri);
			const parsed = JSON.parse(file.value.toString()) as { brandProfile?: BrandSystemProfile };
			if (parsed?.brandProfile && parsed.brandProfile.brandName) {
				this._state = { ...this._state, brandProfile: parsed.brandProfile };
				this._onDidChange.fire();
			}
		} catch { /* file does not exist yet */ }
	}

	private _persistToStorage(): void {
		try {
			// Omit large base64 screenshot dataUrls from workspace storage to keep storage lean
			const slimRevisions = this._state.screenshotRevisions.slice(0, 12).map(r => ({ ...r, dataUrl: undefined }));
			const slimMulti = this._state.latestMultiViewport
				? {
					...this._state.latestMultiViewport,
					captures: this._state.latestMultiViewport.captures.map(c => ({ ...c, dataUrl: '' })),
				}
				: null;
			const toStore: ProjectDesignState = {
				...this._state,
				latestMultiViewport: slimMulti,
				screenshotRevisions: slimRevisions,
			};
			this._storageService.store(DESIGN_STATE_STORAGE_KEY, JSON.stringify(toStore), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		} catch { /* ignore storage quota errors */ }
	}

	private _update(patch: Partial<ProjectDesignState>): void {
		this._state = { ...this._state, ...patch };
		this._persistToStorage();
		this._onDidChange.fire();
	}

	getBrandProfile(): BrandSystemProfile | null {
		return this._state.brandProfile;
	}

	async saveBrandProfile(profile: Omit<BrandSystemProfile, 'updatedAt'>): Promise<BrandSystemProfile> {
		const full: BrandSystemProfile = {
			...profile,
			brandName: profile.brandName.trim() || 'Project Brand',
			updatedAt: new Date().toISOString(),
		};
		this._update({ brandProfile: full });

		const uri = this._getDesignSystemFileUri();
		if (uri) {
			try {
				const folder = this._workspaceContextService.getWorkspace().folders[0];
				if (folder) {
					await this._fileService.createFolder(URI.joinPath(folder.uri, '.kodia'));
				}
				const payload = {
					schemaVersion: 1,
					brandProfile: full,
					latestDirection: this._state.latestDirection?.id ?? null,
					latestPalette: this._state.latestPalette?.seedColors ?? null,
				};
				await this._fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(payload, null, 2)));
			} catch { /* workspace may be read-only */ }
		}
		return full;
	}

	async clearBrandProfile(): Promise<void> {
		this._update({ brandProfile: null });
	}

	recordAnalysis(analysis: ProductDesignAnalysis): void { this._update({ latestAnalysis: analysis }); }
	recordBrief(brief: DesignBrief): void { this._update({ latestBrief: brief }); }
	recordDirection(direction: VisualDirectionSpec): void { this._update({ latestDirection: direction }); }
	recordPalette(palette: ColorPaletteSpec): void { this._update({ latestPalette: palette }); }
	recordTokens(tokens: DesignTokensSpec): void { this._update({ latestTokens: tokens, latestPalette: tokens.palette }); }
	recordArchitecture(arch: PageArchitectureSpec): void { this._update({ latestArchitecture: arch }); }
	recordExistingSystem(report: ExistingDesignSystemReport): void { this._update({ latestExistingSystem: report }); }
	recordConsistencyAudit(report: DesignConsistencyAuditReport): void { this._update({ latestConsistencyAudit: report }); }
	recordVisualAudit(audit: BrowserVisualAuditResult): void { this._update({ latestVisualAudit: audit }); }

	recordMultiViewportAudit(result: MultiViewportAuditResult): void {
		const newRevs: ScreenshotRevisionEntry[] = result.captures.map(c => ({
			id: `rev-${Date.now().toString(36)}-${c.label}`,
			label: `${c.label} (${c.width}x${c.height})`,
			url: result.url,
			width: c.width,
			height: c.height,
			path: c.path,
			dataUrl: c.dataUrl,
			capturedAt: result.capturedAt,
		}));
		this._update({
			latestMultiViewport: result,
			latestVisualAudit: result.captures[result.captures.length - 1]?.audit ?? this._state.latestVisualAudit,
			screenshotRevisions: [...newRevs, ...this._state.screenshotRevisions].slice(0, 18),
		});
	}

	recordCritique(critique: DesignCritiqueReport): void { this._update({ latestCritique: critique }); }
	recordComparison(comparison: VisualRevisionComparison): void { this._update({ latestComparison: comparison }); }

	recordDiscoveredAssets(assets: readonly VisualAssetCandidate[]): void {
		const byId = new Map<string, VisualAssetCandidate>();
		for (const a of [...assets, ...this._state.discoveredAssets]) {
			byId.set(a.id, a);
		}
		this._update({ discoveredAssets: [...byId.values()].slice(0, 40) });
	}

	recordDownloadedAssets(assets: readonly DownloadedVisualAsset[]): void {
		const byPath = new Map<string, DownloadedVisualAsset>();
		for (const a of [...assets.filter(x => x.verifiedOnDisk), ...this._state.downloadedAssets]) {
			byPath.set(a.relativePath || a.localPath, a);
		}
		this._update({ downloadedAssets: [...byPath.values()].slice(0, 40) });
	}

	recordScreenshotRevision(entry: Omit<ScreenshotRevisionEntry, 'id' | 'capturedAt'>): ScreenshotRevisionEntry {
		const full: ScreenshotRevisionEntry = {
			...entry,
			id: `rev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
			capturedAt: new Date().toISOString(),
		};
		this._update({ screenshotRevisions: [full, ...this._state.screenshotRevisions].slice(0, 18) });
		return full;
	}

	formatBrandGuidelinesForPrompt(): string {
		const bp = this._state.brandProfile;
		if (!bp) { return ''; }
		const lines = [
			`PROJECT BRAND SYSTEM (${DESIGN_SYSTEM_WORKSPACE_FILE}):`,
			`- Brand: ${bp.brandName}${bp.tagline ? ` — "${bp.tagline}"` : ''}${bp.industry ? ` (${bp.industry})` : ''}`,
		];
		if (bp.preferredDirection) { lines.push(`- Preferred Visual Direction: ${bp.preferredDirection}`); }
		if (bp.primaryColor || bp.secondaryColor || bp.accentColor) {
			lines.push(`- Brand Colors: primary=${bp.primaryColor || 'auto'}, secondary=${bp.secondaryColor || 'auto'}, accent=${bp.accentColor || 'auto'}`);
		}
		if (bp.headingFont || bp.bodyFont) {
			lines.push(`- Typography: heading="${bp.headingFont || 'auto'}", body="${bp.bodyFont || 'auto'}"${bp.monoFont ? `, mono="${bp.monoFont}"` : ''}`);
		}
		if (bp.logoPath) { lines.push(`- Logo Asset: ${bp.logoPath}`); }
		if (bp.themeMode) { lines.push(`- Theme Mode: ${bp.themeMode}`); }
		if (bp.accessibilityTarget) { lines.push(`- Accessibility Target: ${bp.accessibilityTarget}`); }
		if (bp.imageStyleNotes) { lines.push(`- Imagery Direction: ${bp.imageStyleNotes}`); }
		if (bp.componentStandards) { lines.push(`- Component Standards: ${bp.componentStandards}`); }
		if (bp.restrictions && bp.restrictions.length > 0) {
			lines.push(`- Design Restrictions: ${bp.restrictions.join('; ')}`);
		}
		return lines.join('\n');
	}
}

registerSingleton(IDesignIntelligenceService, DesignIntelligenceService, InstantiationType.Eager);
