export interface WorkspaceResolver {
  resolveAllowed(
    requested: string,
    base: string,
    allowedRoots: readonly string[]
  ): Promise<string>;
}
