import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

/**
 * Resolve a user-supplied file path (for example a Playwright storage state) and
 * require it to live inside the server working directory. Symlinks are resolved so
 * a link cannot escape the workspace either.
 */
export async function resolveWorkspacePath(value: string): Promise<string> {
  const workspace = await realpath(process.cwd())
  let candidate: string
  try {
    candidate = await realpath(isAbsolute(value) ? value : resolve(workspace, value))
  } catch {
    throw new Error('The provided file path does not exist inside the server working directory.')
  }
  const relativePath = relative(workspace, candidate)
  if (relativePath === '..' || relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relativePath)) {
    throw new Error('File paths must resolve to a file inside the server working directory.')
  }
  return candidate
}
