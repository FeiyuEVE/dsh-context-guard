/**
 * Text hygiene for archive documents.
 *
 * The raw archive copies message and tool-result text, and that text legitimately
 * carries control bytes: a shell command that dumps `/proc/<pid>/cmdline` emits
 * NUL separators, and most CLIs wrap output in ANSI colour escapes. A single NUL
 * anywhere in the document is fatal for every reader path:
 *
 * - `@deepseek-ai/dsh-fs-local` refuses a file whose first 8192 bytes contain a
 *   NUL (`FS_NOT_TEXT`, "binary file");
 * - `@deepseek-ai/dsh-api-workspace-files` re-checks the *whole* returned page
 *   and fails with `workspace-file/not-text`, which the Web document preview
 *   renders as 「非文本文件，暂时无法预览。」 — so the archive opens as nothing at
 *   all, exactly when it is the document a reader most needs.
 *
 * ANSI escapes pass those checks but surface as `[1;34m==>` noise in a plain
 * text reader, so they are stripped here too.
 *
 * This mapping is lossy by design, and the loss is bounded and documented: only
 * control bytes and escape sequences are affected, and the session log
 * (`sessions/<id>/session.v3.jsonl.zstd`) remains the byte-exact record.
 *
 * @module dsh-context-guard/sanitize
 */

/**
 * ANSI escape sequences: CSI (`ESC [ params final`), OSC (`ESC ] … BEL | ESC \`),
 * and the two-character `ESC x` forms. Only the sequence is removed; the text
 * around it is preserved.
 */
const ANSI_SEQUENCE = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g

/** Visible replacement for a dropped NUL, so the gap is still legible. */
export const NUL_PLACEHOLDER = '␀'

/** Control characters a Markdown document may keep verbatim. */
const KEPT_CONTROLS = new Set(['\t', '\n'])

/**
 * Make one string safe to store as a text document.
 *
 * - strips ANSI escape sequences;
 * - normalizes CRLF and lone CR to LF;
 * - renders NUL as {@link NUL_PLACEHOLDER};
 * - drops every other C0 control (and DEL), keeping tab and newline.
 *
 * @param text - raw document text, possibly carrying control bytes.
 * @returns text with no NUL and no escape sequences.
 */
export function sanitizeDocText(text: string): string {
  return text
    .replace(ANSI_SEQUENCE, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u001f\u007f]/g, character =>
      KEPT_CONTROLS.has(character)
        ? character
        : character === '\u0000'
          ? NUL_PLACEHOLDER
          : '',
    )
}
