import {
  App,
  debounce,
  Debouncer,
  Notice,
  parseFrontMatterAliases,
  parseFrontMatterTags,
  SuggestModal,
} from "obsidian";
import {
  excludeItems,
  includeItems,
  keyBy,
  uniq,
} from "../utils/collection-helper";
import { SearchCommand, Settings } from "../settings";
import { AppHelper, LeafType } from "../app-helper";
import { stampMatchResults, SuggestionItem } from "src/matcher";
import { createElements } from "./suggestion-factory";
import { filterNoQueryPriorities, sort } from "../sorters";
import { UnsafeModalInterface } from "./UnsafeModalInterface";
import { excludeFormat } from "../utils/strings";
import { MOD, quickResultSelectionModifier } from "src/keys";
import { FILTER, HEADER, LINK, SEARCH, TAG } from "./icons";

function buildLogMessage(message: string, msec: number) {
  return `${message}: ${Math.round(msec)}[ms]`;
}

export class AnotherQuickSwitcherModal
  extends SuggestModal<SuggestionItem>
  implements UnsafeModalInterface<SuggestionItem>
{
  originItems: SuggestionItem[];
  phantomItems: SuggestionItem[];
  ignoredItems: SuggestionItem[];
  appHelper: AppHelper;
  settings: Settings;
  searchQuery: string;

  chooser: UnsafeModalInterface<SuggestionItem>["chooser"];
  scope: UnsafeModalInterface<SuggestionItem>["scope"];

  debounceGetSuggestions: Debouncer<
    [string, (items: SuggestionItem[]) => void],
    void
  >;

  command: SearchCommand;
  initialCommand: SearchCommand;

  searchCommandEl?: HTMLDivElement;
  defaultInputEl?: HTMLDivElement;
  countInputEl?: HTMLDivElement;

  constructor(app: App, settings: Settings, command: SearchCommand) {
    super(app);

    this.appHelper = new AppHelper(app);
    this.settings = settings;
    this.initialCommand = command;
    this.command = command;

    this.limit = this.settings.maxNumberOfSuggestions;
    this.setHotKeys();

    this.phantomItems = this.settings.showExistingFilesOnly
      ? []
      : this.appHelper.searchPhantomFiles().map((x) => ({
          file: x,
          aliases: [],
          tags: [],
          headers: [],
          links: [],
          phantom: true,
          starred: false,
          matchResults: [],
          tokens: x.basename.split(" "),
        }));

    this.indexingItems();

    this.debounceGetSuggestions = debounce(
      (query: string, cb: (items: SuggestionItem[]) => void) => {
        cb(this._getSuggestions(query));
      },
      this.settings.searchDelayMilliSeconds,
      true
    );
  }

  indexingItems() {
    const starredPathMap = keyBy(
      this.appHelper.getStarredFilePaths(),
      (x) => x
    );
    const activeFilePath = app.workspace.getActiveFile()?.path;

    const start = performance.now();
    const markdownItems = app.vault
      .getMarkdownFiles()
      .filter(
        (x) => x.path !== activeFilePath && app.metadataCache.getFileCache(x)
      )
      .map((x) => {
        const cache = app.metadataCache.getFileCache(x)!; // already filtered
        return {
          file: x,
          aliases: parseFrontMatterAliases(cache.frontmatter) ?? [],
          tags: this.command.searchBy.tag
            ? uniq([
                ...(cache.tags ?? []).map((x) => x.tag),
                ...(parseFrontMatterTags(cache.frontmatter) ?? []),
              ])
            : [],
          headers: this.command.searchBy.header
            ? (cache.headings ?? []).map((x) => excludeFormat(x.heading))
            : [],
          links: this.command.searchBy.link
            ? uniq(cache.links?.map((x) => x.displayText ?? "") ?? [])
            : [],
          phantom: false,
          starred: x.path in starredPathMap,
          matchResults: [],
          tokens: x.basename.split(" "),
        };
      });
    this.showDebugLog(() =>
      buildLogMessage(`Indexing markdown items: `, performance.now() - start)
    );

    this.originItems = [...markdownItems, ...this.phantomItems];
    this.ignoredItems = this.prefilterItems(this.command);
  }

  async handleCreateNew(
    searchQuery: string,
    leafType: LeafType
  ): Promise<boolean> {
    if (!searchQuery) {
      return true;
    }

    const file = await this.appHelper.createMarkdown(this.searchQuery);
    if (!file) {
      // noinspection ObjectAllocationIgnored
      new Notice("This file already exists.");
      return true;
    }

    this.close();
    this.appHelper.openMarkdownFile(file, { leaf: leafType });
    return false;
  }

  prefilterItems(command: SearchCommand): SuggestionItem[] {
    const filterItems = (
      includePatterns: string[],
      excludePatterns: string[]
    ): SuggestionItem[] => {
      let items = this.originItems;
      if (includePatterns.length > 0) {
        items = includeItems(items, includePatterns, (x) => x.file.path);
      }
      if (excludePatterns.length > 0) {
        items = excludeItems(items, excludePatterns, (x) => x.file.path);
      }
      return items;
    };

    const currentDirPath = this.appHelper.getActiveFile()?.parent.path ?? "";
    return command.isBacklinkSearch
      ? filterItems([], this.settings.backLinkExcludePrefixPathPatterns)
      : filterItems(
          command.includePrefixPathPatterns.map((p) =>
            p.replace(/<current_dir>/g, currentDirPath)
          ),
          command.excludePrefixPathPatterns.map((p) =>
            p.replace(/<current_dir>/g, currentDirPath)
          )
        );
  }

  getSuggestions(query: string): SuggestionItem[] | Promise<SuggestionItem[]> {
    if (!query || query === this.command.defaultInput) {
      return this._getSuggestions(query);
    }

    return new Promise((resolve) => {
      this.debounceGetSuggestions(query, (items) => {
        resolve(items);
      });
    });
  }

  _getSuggestions(query: string): SuggestionItem[] {
    const start = performance.now();

    let lastOpenFileIndexByPath: { [path: string]: number } = {};
    this.app.workspace.getLastOpenFiles().forEach((v, i) => {
      lastOpenFileIndexByPath[v] = i;
    });

    const commandByPrefix = this.settings.searchCommands
      .filter((x) => x.commandPrefix)
      .find((x) => query.startsWith(x.commandPrefix));

    if (
      (commandByPrefix || this.initialCommand !== this.command) &&
      commandByPrefix !== this.command
    ) {
      this.showDebugLog(() => `beforeCommand: ${this.command.name}`);
      this.command = commandByPrefix ?? this.initialCommand;
      this.indexingItems(); // slow?
      this.showDebugLog(() => `afterCommand: ${this.command.name}`);
    }
    this.searchQuery = query.startsWith(this.command.commandPrefix)
      ? query.replace(this.command.commandPrefix, "")
      : query;
    if (this.command.defaultInput) {
      this.searchQuery = `${this.command.defaultInput}${this.searchQuery}`;
    }

    this.renderInputComponent();

    const qs = this.searchQuery.split(" ").filter((x) => x);

    if (this.command.isBacklinkSearch) {
      const activeFilePath = this.app.workspace.getActiveFile()?.path;
      if (!activeFilePath) {
        return [];
      }

      // ✨ If I can use MetadataCache.getBacklinksForFile, I would like to use it instead of original createBacklinksMap :)
      const backlinksMap = this.appHelper.createBacklinksMap();
      const items = this.ignoredItems
        .filter((x) => backlinksMap[activeFilePath]?.has(x.file.path))
        .map((x) =>
          stampMatchResults(
            x,
            qs,
            false,
            false,
            false,
            this.settings.normalizeAccentsAndDiacritics
          )
        )
        .filter((x) => x.matchResults.every((x) => x.type !== "not found"))
        .slice(0, this.settings.maxNumberOfSuggestions);
      this.showDebugLog(() =>
        buildLogMessage(`Get suggestions: ${query}`, performance.now() - start)
      );
      return items.map((x, order) => ({ ...x, order }));
    }

    if (!this.searchQuery.trim()) {
      const results = sort(
        this.ignoredItems,
        filterNoQueryPriorities(this.command.sortPriorities),
        lastOpenFileIndexByPath
      )
        .slice(0, this.settings.maxNumberOfSuggestions)
        .map((x, order) => ({ ...x, order }));

      this.showDebugLog(() =>
        buildLogMessage(
          `Get suggestions: ${this.searchQuery} (${this.command.name})`,
          performance.now() - start
        )
      );
      return results;
    }

    const matchedSuggestions = this.ignoredItems
      .map((x) =>
        stampMatchResults(
          x,
          qs,
          this.command.searchBy.tag,
          this.command.searchBy.header,
          this.command.searchBy.link,
          this.settings.normalizeAccentsAndDiacritics
        )
      )
      .filter((x) => x.matchResults.every((x) => x.type !== "not found"));

    const items = sort(
      matchedSuggestions,
      this.command.sortPriorities,
      lastOpenFileIndexByPath
    );

    this.showDebugLog(() =>
      buildLogMessage(
        `Get suggestions: ${this.searchQuery} (${this.command.name})`,
        performance.now() - start
      )
    );

    this.countInputEl = createDiv({
      text: `${Math.min(
        items.length,
        this.settings.maxNumberOfSuggestions
      )} / ${items.length}`,
      cls: "another-quick-switcher__status__count-input",
    });
    this.inputEl.before(this.countInputEl);

    return items
      .slice(0, this.settings.maxNumberOfSuggestions)
      .map((x, order) => ({ ...x, order }));
  }

  renderInputComponent() {
    this.searchCommandEl?.remove();
    this.defaultInputEl?.remove();
    this.countInputEl?.remove();

    this.searchCommandEl = createDiv({
      cls: "another-quick-switcher__status__search-command",
    });
    this.searchCommandEl.insertAdjacentHTML("beforeend", SEARCH);

    if (this.command.isBacklinkSearch) {
      this.searchCommandEl.appendText(`Backlink search`);
    } else {
      this.searchCommandEl.appendText(`${this.command.name} ... `);
    }
    if (this.command.searchBy.tag) {
      this.searchCommandEl.insertAdjacentHTML("beforeend", TAG);
    }
    if (this.command.searchBy.header) {
      this.searchCommandEl.insertAdjacentHTML("beforeend", HEADER);
    }
    if (this.command.searchBy.link) {
      this.searchCommandEl.insertAdjacentHTML("beforeend", LINK);
    }
    this.inputEl.before(this.searchCommandEl);

    if (this.command.defaultInput) {
      this.defaultInputEl = createDiv({
        text: this.searchQuery,
        cls: "another-quick-switcher__status__default-input",
      });
      this.defaultInputEl.insertAdjacentHTML("afterbegin", FILTER);
      this.resultContainerEl.before(this.defaultInputEl);
    }
  }

  renderSuggestion(item: SuggestionItem, el: HTMLElement) {
    const { itemDiv, descriptionDiv } = createElements(item, {
      showDirectory: this.settings.showDirectory,
      showDirectoryAtNewLine: this.settings.showDirectoryAtNewLine,
      showFullPathOfDirectory: this.settings.showFullPathOfDirectory,
      showAliasesOnTop: this.settings.showAliasesOnTop,
      hideGutterIcons: this.settings.hideGutterIcons,
    });

    if (descriptionDiv?.hasChildNodes()) {
      itemDiv.appendChild(descriptionDiv);
    }
    el.appendChild(itemDiv);
  }

  onNoSuggestion() {
    super.onNoSuggestion();

    const createButton = createEl("button", {
      text: "Create",
      cls: "another-quick-switcher__create_button",
    });
    createButton.addEventListener("click", () =>
      this.handleCreateNew(this.searchQuery, "same-tab")
    );
    this.resultContainerEl.appendChild(createButton);
  }

  async chooseCurrentSuggestion(leaf: LeafType): Promise<boolean> {
    const item = this.chooser.values?.[this.chooser.selectedItem];
    if (!item) {
      return true;
    }

    let fileToOpened = item.file;
    if (item.phantom) {
      fileToOpened = await this.app.vault.create(item.file.path, "");
    }

    const offset = this.command.isBacklinkSearch
      ? this.appHelper.findFirstLinkOffset(
          item.file,
          this.app.workspace.getActiveFile()! // never undefined
        )
      : undefined;

    this.close();
    this.appHelper.openMarkdownFile(fileToOpened, { leaf: leaf, offset });

    return false;
  }

  async onChooseSuggestion(
    item: SuggestionItem,
    evt: MouseEvent | KeyboardEvent
  ): Promise<any> {
    await this.chooseCurrentSuggestion("same-tab");
  }

  private showDebugLog(toMessage: () => string) {
    if (this.settings.showLogAboutPerformanceInConsole) {
      console.log(toMessage());
    }
  }

  private setHotKeys() {
    const openNthMod = quickResultSelectionModifier(
      this.settings.userAltInsteadOfModForQuickResultSelection
    );

    if (!this.settings.hideHotkeyGuides) {
      this.setInstructions([
        {
          command: `[↑↓][${MOD} n or p][${MOD} j or k]`,
          purpose: "navigate",
        },
        { command: `[${openNthMod} 1~9]`, purpose: "open Nth" },
        { command: `[${MOD} d]`, purpose: "clear input" },
        { command: "[tab]", purpose: "replace input" },
        { command: "[↵]", purpose: "open" },
        { command: `[${MOD} ↵]`, purpose: "open in new tab" },
        { command: `[${MOD} -]`, purpose: "open in new pane (horizontal)" },
        { command: `[${MOD} shift -]`, purpose: "open in new pane (vertical)" },
        { command: `[${MOD} o]`, purpose: "open in new window" },
        { command: `[${MOD} alt ↵]`, purpose: "open in popup" },
        { command: "[shift ↵]", purpose: "create" },
        { command: `[${MOD} shift ↵]`, purpose: "create in new tab" },
        { command: `[${MOD} shift o]`, purpose: "create in new window" },
        { command: `[${MOD} shift alt ↵]`, purpose: "create in popup" },
        { command: `[${MOD} shift alt o]`, purpose: "open all in new tabs" },
        { command: `[${MOD} ]]`, purpose: "open first URL" },
        { command: "[alt ↵]", purpose: "insert to editor" },
        { command: "[alt shift ↵]", purpose: "insert all to editor" },
        { command: "[esc]", purpose: "dismiss" },
      ]);
    }

    this.scope.register(["Mod"], "Enter", () =>
      this.chooseCurrentSuggestion("new-tab")
    );
    this.scope.register(["Alt"], "Enter", () => {
      const file = this.chooser.values?.[this.chooser.selectedItem]?.file;
      if (!file) {
        return;
      }

      this.close();
      this.appHelper.insertLinkToActiveFileBy(file);
      return false;
    });
    this.scope.register(["Alt", "Shift"], "Enter", () => {
      this.close();
      this.chooser.values?.forEach((x) => {
        this.appHelper.insertLinkToActiveFileBy(x.file);
        this.appHelper.insertStringToActiveFile("\n");
      });
      return false;
    });
    this.scope.register(["Mod"], "-", () =>
      this.chooseCurrentSuggestion("new-pane-horizontal")
    );
    this.scope.register(["Mod", "Shift"], "-", () =>
      this.chooseCurrentSuggestion("new-pane-vertical")
    );
    this.scope.register(["Mod"], "o", () =>
      this.chooseCurrentSuggestion("new-window")
    );
    this.scope.register(["Mod", "Alt"], "Enter", () =>
      this.chooseCurrentSuggestion("popup")
    );

    const modifierKey = this.settings.userAltInsteadOfModForQuickResultSelection
      ? "Alt"
      : "Mod";
    [1, 2, 3, 4, 5, 6, 7, 8, 9].forEach((n) => {
      this.scope.register([modifierKey], String(n), (evt: KeyboardEvent) => {
        this.chooser.setSelectedItem(n - 1, evt);
        return this.chooseCurrentSuggestion("same-tab");
      });
    });

    this.scope.register(["Shift"], "Enter", () =>
      this.handleCreateNew(this.searchQuery, "same-tab")
    );
    this.scope.register(["Shift", "Mod"], "Enter", () =>
      this.handleCreateNew(this.searchQuery, "new-tab")
    );
    this.scope.register(["Shift", "Mod"], "o", () =>
      this.handleCreateNew(this.searchQuery, "new-window")
    );
    this.scope.register(["Shift", "Mod", "Alt"], "Enter", () =>
      this.handleCreateNew(this.searchQuery, "popup")
    );
    this.scope.register(["Shift", "Mod", "Alt"], "o", () => {
      this.close();
      if (this.chooser.values == null) {
        return;
      }

      this.chooser.values
        .slice()
        .reverse()
        .forEach((x) =>
          this.appHelper.openMarkdownFile(x.file, {
            leaf: "new-tab-background",
          })
        );
    });

    this.scope.register(["Mod"], "N", () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown" })
      );
    });
    this.scope.register(["Mod"], "P", () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
    });
    this.scope.register(["Mod"], "J", () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown" })
      );
    });
    this.scope.register(["Mod"], "K", () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
    });

    this.scope.register([], "Tab", (evt) => {
      evt.preventDefault();

      if (this.chooser.values) {
        this.inputEl.value =
          this.chooser.values[this.chooser.selectedItem].file.basename;
        // Necessary to rerender suggestions
        this.inputEl.dispatchEvent(new Event("input"));
      }
    });
    this.scope.register(["Mod"], "D", () => {
      this.inputEl.value = "";
      // Necessary to rerender suggestions
      this.inputEl.dispatchEvent(new Event("input"));
    });

    this.scope.register(["Mod"], "]", async () => {
      const fileToOpened =
        this.chooser.values?.[this.chooser.selectedItem]?.file;
      if (!fileToOpened) {
        return false;
      }

      this.close();

      const urls = await this.appHelper.findExternalLinkUrls(fileToOpened);
      if (urls.length > 0) {
        activeWindow.open(urls[0]);
      } else {
        this.appHelper.openMarkdownFile(fileToOpened, {
          leaf: "same-tab",
        });
      }

      return false;
    });
  }
}
