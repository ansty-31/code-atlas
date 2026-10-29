/**
 * Application state shapes.
 *
 * Kept apart from `schema.ts` so the settings schema can be imported on its own
 * (unit tests, and the persistence layer) without dragging in the atlas types.
 */

import type { Atlas } from '../domain';
import type { Settings } from './schema';

export type ViewId = 'treemap' | 'hierarchy' | 'dependencies' | 'subsystems' | 'insights';

/** Sub-mode of the Dependencies view. */
export type DepMode = 'graph' | 'matrix' | 'classes';

export interface Selection {
  classId: number | null;
  packagePath: string | null;
  hoverId: number | null;
  /** zoom path for the treemap: package paths or synthetic group ids */
  zoom: string[];
}

export interface AppState {
  view: ViewId;
  depMode: DepMode;
  settings: Settings;
  selection: Selection;
  /** non-null when a search/highlight set is active */
  highlightIds: Set<number> | null;
  ready: boolean;
  atlas: Atlas | null;
  status: string;
}
