import {
  App,
  Editor,
  getLinkpath,
  HeadingCache,
  LinkCache,
  MarkdownView,
  Pos,
  TFile,
  TFolder,
  Vault,
  Workspace,
  WorkspaceLeaf,
} from "obsidian";
import { flatten, uniq } from "./utils/collection-helper";
import { basename, dirname, extname } from "./utils/path";
import { ExhaustiveError } from "./errors";

interface UnsafeAppInterface {
  internalPlugins: {
    plugins: {
      starred: {
        instance: {
          items: { path: string }[];
        };
      };
    };
  };
  commands: {
    removeCommand(id: string): void;
    commands: { [commandId: string]: any };
  };
  plugins: {
    plugins: {
      "obsidian-hover-editor"?: {
        spawnPopover(
          initiatingEl?: HTMLElement,
          onShowCallback?: () => unknown
        ): WorkspaceLeaf;
      };
    };
  };
  vault: Vault & {
    config: {
      newFileLocation?: "root" | "current" | "folder";
      newFileFolderPath?: string;
    };
  };
  workspace: Workspace & {
    openPopoutLeaf(): WorkspaceLeaf;
  };
}

interface UnSafeLayoutChild {
  id: string;
  type: "tabs";
}
interface UnSafeLayout {
  id: string;
  type: "split";
  children: UnSafeLayoutChild[];
  direction: "horizontal" | "vertical";
  width: number;
  collapsed?: boolean;
}
interface UnsafeLayouts {
  active: string;
  left: UnSafeLayout;
  main: UnSafeLayout;
  right: UnSafeLayout;
}

export type LeafType =
  | "same-tab"
  | "new-tab"
  | "new-tab-background"
  | "new-pane-vertical"
  | "new-pane-horizontal"
  | "new-window"
  | "popup";
type OpenMarkdownFileOption = {
  leaf: LeafType;
  offset?: number;
  line?: number;
};

export class AppHelper {
  private unsafeApp: App & UnsafeAppInterface;

  constructor(app: App) {
    this.unsafeApp = app as any;
  }

  getActiveFile(): TFile | null {
    return this.unsafeApp.workspace.getActiveFile();
  }

  getMarkdownViewInActiveLeaf(): MarkdownView | null {
    if (!this.unsafeApp.workspace.getActiveViewOfType(MarkdownView)) {
      return null;
    }

    return this.unsafeApp.workspace.activeLeaf!.view as MarkdownView;
  }

  getCurrentEditor(): Editor | null {
    return this.getMarkdownViewInActiveLeaf()?.editor ?? null;
  }

  getCurrentOffset(): number | null {
    const editor = this.getCurrentEditor();
    if (!editor) {
      return null;
    }

    const cursor = this.getCurrentEditor()?.getCursor();
    if (!cursor) {
      return null;
    }

    return editor.posToOffset(cursor);
  }

  getHeadersInActiveFile(): HeadingCache[] {
    const activeFile = this.getActiveFile();
    if (!activeFile) {
      return [];
    }

    return (
      this.unsafeApp.metadataCache.getFileCache(activeFile)?.headings ?? []
    );
  }

  getOutgoingLinksInActiveFile(): LinkCache[] {
    const activeFile = this.getActiveFile();
    if (!activeFile) {
      return [];
    }

    return (
      this.unsafeApp.metadataCache.getFileCache(activeFile)?.links ?? []
    );
  }

  getFolders(): TFolder[] {
    return this.unsafeApp.vault
      .getAllLoadedFiles()
      .filter((x) => x instanceof TFolder) as TFolder[];
  }

  getLayout(): UnsafeLayouts {
    return this.unsafeApp.workspace.getLayout() as UnsafeLayouts;
  }

  getLeftSideBarWidth(): number {
    return this.getLayout().left.collapsed ? 0 : this.getLayout().left.width;
  }

  getRightSideBarWidth(): number {
    return this.getLayout().right.collapsed ? 0 : this.getLayout().right.width;
  }

  async findExternalLinkUrls(file: TFile): Promise<string[]> {
    const content = await this.unsafeApp.vault.read(file);
    const matches = Array.from(content.matchAll(/https?:\/\/[^ \n)]+/g));
    return matches.map((x) => x[0]);
  }

  findFirstLinkOffset(file: TFile, linkFile: TFile): number {
    const fileCache = this.unsafeApp.metadataCache.getFileCache(file);
    const links = fileCache?.links ?? [];
    const embeds = fileCache?.embeds ?? [];

    return [...links, ...embeds].find((x: LinkCache) => {
      const toLinkFilePath = this.unsafeApp.metadataCache.getFirstLinkpathDest(
        getLinkpath(x.link),
        file.path
      )?.path;
      return toLinkFilePath === linkFile.path;
    })!.position.start.offset;
  }

  // noinspection FunctionWithMultipleLoopsJS
  createBacklinksMap(): Record<string, Set<string>> {
    const backLinksMap: Record<string, Set<string>> = {};

    for (const [filePath, linkMap] of Object.entries(
      this.unsafeApp.metadataCache.resolvedLinks
    ) as [string, Record<string, number>][]) {
      for (const linkPath of Object.keys(linkMap)) {
        if (!backLinksMap[linkPath]) {
          backLinksMap[linkPath] = new Set();
        }
        backLinksMap[linkPath].add(filePath);
      }
    }

    return backLinksMap;
  }

  async moveTo(to: Pos | number, editor?: Editor) {
    const isToOffset = typeof to === "number";

    const activeFile = this.getActiveFile();
    const activeLeaf = this.unsafeApp.workspace.activeLeaf;
    if (!activeFile || !activeLeaf) {
      return;
    }

    const subView = this.getMarkdownViewInActiveLeaf()?.currentMode;
    if (!subView) {
      return;
    }

    const targetEditor = editor ?? this.getCurrentEditor();
    if (!targetEditor) {
      return;
    }

    const line = isToOffset ? targetEditor.offsetToPos(to).line : to.start.line;
    targetEditor.setCursor(
      targetEditor.offsetToPos(isToOffset ? to : to.start.offset)
    );
    await activeLeaf.openFile(activeFile, {
      eState: {
        line,
      },
      active: false,
    });
  }

  getMarkdownFileByPath(path: string): TFile | null {
    if (!path.endsWith(".md")) {
      return null;
    }

    const abstractFile = this.unsafeApp.vault.getAbstractFileByPath(path);
    if (!abstractFile) {
      return null;
    }

    return abstractFile as TFile;
  }

  openMarkdownFile(file: TFile, option: Partial<OpenMarkdownFileOption> = {}) {
    const opt: OpenMarkdownFileOption = {
      ...{ leaf: "same-tab" },
      ...option,
    };

    const openFile = (leaf: WorkspaceLeaf, background = false) => {
      leaf
        .openFile(file, {
          ...this.unsafeApp.workspace.activeLeaf?.getViewState(),
          active: !background,
        })
        .then(() => {
          const markdownView =
            this.unsafeApp.workspace.getActiveViewOfType(MarkdownView);
          if (markdownView) {
            if (opt.offset != null) {
              this.moveTo(opt.offset, markdownView.editor);
            } else if (opt.line != null) {
              const p = { line: opt.line, offset: 0, col: 0 };
              this.moveTo({ start: p, end: p });
            }
          }
        });
    };

    let leaf: WorkspaceLeaf;
    switch (opt.leaf) {
      case "same-tab":
        leaf = this.unsafeApp.workspace.getLeaf();
        openFile(leaf);
        break;
      case "new-tab":
        leaf = this.unsafeApp.workspace.getLeaf(true);
        openFile(leaf);
        break;
      case "new-tab-background":
        leaf = this.unsafeApp.workspace.getLeaf(true);
        openFile(leaf, true);
        break;
      case "new-pane-horizontal":
        leaf = this.unsafeApp.workspace.getLeaf("split", "horizontal");
        openFile(leaf);
        break;
      case "new-pane-vertical":
        leaf = this.unsafeApp.workspace.getLeaf("split", "vertical");
        openFile(leaf);
        break;
      case "new-window":
        openFile(this.unsafeApp.workspace.openPopoutLeaf());
        break;
      case "popup":
        const hoverEditorInstance =
          this.unsafeApp.plugins.plugins["obsidian-hover-editor"];
        if (hoverEditorInstance) {
          leaf = hoverEditorInstance.spawnPopover(undefined, () => {
            openFile(leaf);
          });
        } else {
          openFile(this.unsafeApp.workspace.getLeaf());
        }
        break;
      default:
        throw new ExhaustiveError(opt.leaf);
    }
  }

  getStarredFilePaths(): string[] {
    return this.unsafeApp.internalPlugins.plugins.starred.instance.items.map(
      (x) => x.path
    );
  }

  searchPhantomFiles(): TFile[] {
    return uniq(
      flatten(
        Object.values(this.unsafeApp.metadataCache.unresolvedLinks).map(
          Object.keys
        )
      )
    ).map((x) => this.createPhantomFile(x));
  }

  insertStringToActiveFile(str: string) {
    const activeMarkdownView =
      this.unsafeApp.workspace.getActiveViewOfType(MarkdownView);
    if (!activeMarkdownView) {
      return;
    }

    const editor = activeMarkdownView.editor;
    editor.replaceSelection(str);
  }

  insertLinkToActiveFileBy(file: TFile) {
    const activeMarkdownView =
      this.unsafeApp.workspace.getActiveViewOfType(MarkdownView);
    if (!activeMarkdownView) {
      return;
    }

    const linkText = this.unsafeApp.fileManager.generateMarkdownLink(
      file,
      activeMarkdownView.file.path
    );

    const editor = activeMarkdownView.editor;
    editor.replaceSelection(linkText);
  }

  async createMarkdown(linkText: string): Promise<TFile | null> {
    const linkPath = this.getPathToBeCreated(linkText);
    if (await this.exists(linkPath)) {
      return null;
    }

    const dir = dirname(linkPath);
    if (!(await this.exists(dir))) {
      await this.unsafeApp.vault.createFolder(dir);
    }

    return this.unsafeApp.vault.create(linkPath, "");
  }

  exists(normalizedPath: string): Promise<boolean> {
    return this.unsafeApp.vault.adapter.exists(normalizedPath);
  }

  isPopWindow(): boolean {
    // XXX: Hacky implementation!!
    return !fish(".modal-bg");
  }

  removeCommand(commandId: string) {
    this.unsafeApp.commands.removeCommand(commandId);
  }

  getCommandIds(manifestId: string): string[] {
    return Object.keys(this.unsafeApp.commands.commands).filter((x) =>
      x.startsWith(manifestId)
    );
  }

  private getPathToBeCreated(linkText: string): string {
    let linkPath = getLinkpath(linkText);
    if (extname(linkPath) !== ".md") {
      linkPath += ".md";
    }

    if (linkPath.includes("/")) {
      return linkPath;
    }

    switch (this.unsafeApp.vault.config.newFileLocation) {
      case "root":
        return `/${linkPath}`;
      case "current":
        return `${this.getActiveFile()?.parent.path ?? ""}/${linkPath}`;
      case "folder":
        return `${this.unsafeApp.vault.config.newFileFolderPath}/${linkPath}`;
      default:
        // Normally, same as the "root"
        return `/${linkPath}`;
    }
  }

  // TODO: Use another interface instead of TFile
  private createPhantomFile(linkText: string): TFile {
    const linkPath = this.getPathToBeCreated(linkText);

    // @ts-ignore
    return {
      path: linkPath,
      name: basename(linkPath),
      vault: this.unsafeApp.vault,
      extension: "md",
      basename: basename(linkPath, ".md"),
      parent: {
        name: basename(dirname(linkPath)),
        path: dirname(linkPath),
        vault: this.unsafeApp.vault,
        // XXX: From here, Untrusted properties
        children: [],
        // @ts-ignore
        parent: null,
        isRoot: () => true,
      },
      stat: {
        mtime: 0,
        ctime: 0,
        size: 0,
      },
    };
  }
}
