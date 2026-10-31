/**
 * Historial de deshacer/rehacer por instantáneas. El documento es inmutable
 * (cada cambio crea objetos nuevos y comparte lo que no cambia), así que guardar
 * una instantánea cuesta casi nada.
 */
export class History<T> {
  private readonly undoStack: Array<{ snapshot: T; label: string }> = [];
  private readonly redoStack: Array<{ snapshot: T; label: string }> = [];

  constructor(private readonly limit = 200) {}

  /** Guarda el estado ANTERIOR a un cambio. */
  record(previous: T, label: string): void {
    this.undoStack.push({ snapshot: previous, label });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0; // un cambio nuevo invalida lo que se podía rehacer
  }

  undo(current: T): { snapshot: T; label: string } | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.redoStack.push({ snapshot: current, label: entry.label });
    return entry;
  }

  redo(current: T): { snapshot: T; label: string } | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.undoStack.push({ snapshot: current, label: entry.label });
    return entry;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoLabel(): string | null {
    return this.undoStack[this.undoStack.length - 1]?.label ?? null;
  }

  get redoLabel(): string | null {
    return this.redoStack[this.redoStack.length - 1]?.label ?? null;
  }
}
