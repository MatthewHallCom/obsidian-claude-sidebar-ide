import { App, Modal } from "obsidian";

export class DiffModal extends Modal {
  private filePath: string;
  private oldContent: string;
  private newContent: string;
  private applyChange: (relPath: string, content: string) => Promise<void>;
  private resolve: (value: "FILE_SAVED" | "DIFF_REJECTED") => void;
  private resolved = false;

  private constructor(
    app: App,
    filePath: string,
    oldContent: string,
    newContent: string,
    applyChange: (relPath: string, content: string) => Promise<void>,
    resolve: (value: "FILE_SAVED" | "DIFF_REJECTED") => void,
  ) {
    super(app);
    this.filePath = filePath;
    this.oldContent = oldContent;
    this.newContent = newContent;
    this.applyChange = applyChange;
    this.resolve = resolve;
  }

  static show(
    app: App,
    filePath: string,
    oldContent: string,
    newContent: string,
    applyChange: (relPath: string, content: string) => Promise<void>,
  ): Promise<"FILE_SAVED" | "DIFF_REJECTED"> {
    return new Promise((resolve) => {
      const modal = new DiffModal(app, filePath, oldContent, newContent, applyChange, resolve);
      modal.open();
    });
  }

  private doResolve(value: "FILE_SAVED" | "DIFF_REJECTED"): void {
    if (this.resolved) return;
    this.resolved = true;
    this.resolve(value);
  }

  onOpen(): void {
    this.titleEl.setText(`Diff: ${this.filePath.split("/").pop()}`);
    const contentEl = this.contentEl;

    const container = contentEl.createDiv();
    container.style.cssText =
      "display:flex;gap:8px;max-height:60vh;overflow:auto;font-family:monospace;font-size:12px;";

    const oldPre = container.createEl("pre");
    oldPre.style.cssText =
      "flex:1;background:rgba(255,0,0,0.05);padding:8px;border-radius:4px;overflow:auto;white-space:pre-wrap;word-break:break-word;border:1px solid rgba(255,0,0,0.2);";
    oldPre.setText(this.oldContent);

    const newPre = container.createEl("pre");
    newPre.style.cssText =
      "flex:1;background:rgba(0,255,0,0.05);padding:8px;border-radius:4px;overflow:auto;white-space:pre-wrap;word-break:break-word;border:1px solid rgba(0,255,0,0.2);";
    newPre.setText(this.newContent);

    const btnContainer = contentEl.createDiv();
    btnContainer.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:12px;";

    const rejectBtn = btnContainer.createEl("button", { text: "Reject" });
    rejectBtn.addEventListener("click", () => {
      this.close();
      this.doResolve("DIFF_REJECTED");
    });

    const acceptBtn = btnContainer.createEl("button", { text: "Accept", cls: "mod-cta" });
    acceptBtn.addEventListener("click", async () => {
      await this.applyChange(this.filePath, this.newContent);
      this.close();
      this.doResolve("FILE_SAVED");
    });
  }

  onClose(): void {
    this.doResolve("DIFF_REJECTED");
  }
}
