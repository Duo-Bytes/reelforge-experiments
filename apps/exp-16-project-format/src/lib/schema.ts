// Versioned project schema with explicit migrations.
//
// SchemaV1: { version, name, clips: [{ id, start, length }] }
// SchemaV2: { version, name, clips: [{ id, start, length, track }] }
//   - new "track" field on every clip, default 0
// SchemaV3 would be added here next.
//
// The migrator is a chain of v1->v2->...; loading any older version replays
// the entire chain forward. This is the same shape that survived 30 years of
// Vim/Photoshop/Premiere project format evolution.

export const CURRENT_VERSION = 2 as const;

export type ClipV1 = {
  id: string;
  start: number; // seconds
  length: number; // seconds
};

export type ClipV2 = ClipV1 & {
  track: number;
};

export type ProjectV1 = {
  version: 1;
  name: string;
  clips: ClipV1[];
};

export type ProjectV2 = {
  version: 2;
  name: string;
  clips: ClipV2[];
};

export type Project = ProjectV2;

// Each action that mutates a project. The journal is a sequence of these.
export type Action =
  | { type: "create"; project: Project }
  | { type: "rename"; name: string }
  | { type: "add_clip"; clip: ClipV2 }
  | { type: "remove_clip"; id: string }
  | { type: "move_clip"; id: string; start: number }
  | { type: "set_track"; id: string; track: number };

export function emptyProject(name: string): Project {
  return { version: CURRENT_VERSION, name, clips: [] };
}

export function migrate(raw: unknown): Project {
  if (raw === null || typeof raw !== "object") {
    throw new Error("project is not an object");
  }
  const r = raw as { version?: number };
  if (typeof r.version !== "number") {
    throw new Error("project missing version");
  }
  let p: unknown = raw;
  if (r.version === 1) p = migrateV1toV2(p as ProjectV1);
  // future: if (r.version === 2) p = migrateV2toV3(p as ProjectV2);
  const final = p as Project;
  if (final.version !== CURRENT_VERSION) {
    throw new Error(
      `unsupported project version ${(final as { version: number }).version}`,
    );
  }
  return final;
}

function migrateV1toV2(p: ProjectV1): ProjectV2 {
  return {
    version: 2,
    name: p.name,
    clips: p.clips.map((c) => ({ ...c, track: 0 })),
  };
}

export function applyAction(p: Project, a: Action): Project {
  switch (a.type) {
    case "create":
      return a.project;
    case "rename":
      return { ...p, name: a.name };
    case "add_clip":
      return { ...p, clips: [...p.clips, a.clip] };
    case "remove_clip":
      return { ...p, clips: p.clips.filter((c) => c.id !== a.id) };
    case "move_clip":
      return {
        ...p,
        clips: p.clips.map((c) =>
          c.id === a.id ? { ...c, start: a.start } : c,
        ),
      };
    case "set_track":
      return {
        ...p,
        clips: p.clips.map((c) =>
          c.id === a.id ? { ...c, track: a.track } : c,
        ),
      };
    default: {
      // exhaustive
      const _exhaustive: never = a;
      void _exhaustive;
      return p;
    }
  }
}
