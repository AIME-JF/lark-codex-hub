export interface ProjectDirectoryInspection {
  cwd?: string;
  reason?: "missing_cwd" | "missing_directory" | "unsafe_directory";
  detail?: string;
}

export interface WorkspaceResolver {
  inspectProject(requested: string): Promise<ProjectDirectoryInspection>;
  resolveProject(requested: string): Promise<string>;
  resolveAllowed(
    requested: string,
    base: string,
    allowedRoots: readonly string[]
  ): Promise<string>;
}
