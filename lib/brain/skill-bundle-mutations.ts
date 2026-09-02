/**
 * Shared skill-bundle mutation coercion (manifest generator + installer).
 */

export type BundleMutation =
  | {
      type: "append_block_if_missing";
      path: string;
      content: string;
      match?: string;
      required?: boolean;
    }
  | {
      type: "json_set";
      path: string;
      key_path: string[];
      value: unknown;
      required?: boolean;
    };

type LegacyAppendMutation = { file: string; append: string; reason?: string };

function coerceOne(raw: unknown): BundleMutation | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  if (m.type === "append_block_if_missing" && typeof m.path === "string" && typeof m.content === "string") {
    return {
      type: "append_block_if_missing",
      path: m.path,
      content: m.content,
      match: typeof m.match === "string" ? m.match : undefined,
      required: typeof m.required === "boolean" ? m.required : undefined,
    };
  }
  if (m.type === "json_set" && typeof m.path === "string" && Array.isArray(m.key_path)) {
    if (!m.key_path.every((k) => typeof k === "string")) return null;
    return {
      type: "json_set",
      path: m.path,
      key_path: m.key_path as string[],
      value: m.value,
      required: typeof m.required === "boolean" ? m.required : undefined,
    };
  }
  if (typeof m.file === "string" && typeof m.append === "string") {
    const legacy = m as LegacyAppendMutation;
    const content = legacy.append.endsWith("\n") ? legacy.append : `${legacy.append}\n`;
    return { type: "append_block_if_missing", path: legacy.file, content };
  }
  return null;
}

/**
 * Normalize extras/manifest mutations to the installer contract.
 * Unrecognized object entries throw (fail closed on author typos).
 */
export function normalizeBundleMutations(mutations: unknown[]): BundleMutation[] {
  const out: BundleMutation[] = [];
  for (let i = 0; i < mutations.length; i++) {
    const raw = mutations[i];
    const coerced = coerceOne(raw);
    if (coerced) {
      out.push(coerced);
      continue;
    }
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      throw new Error(
        `Unrecognized skill-bundle mutation at index ${i}: expected append_block_if_missing, json_set, or legacy {file, append}`,
      );
    }
    throw new Error(`Invalid skill-bundle mutation at index ${i}: expected an object`);
  }
  return out;
}
