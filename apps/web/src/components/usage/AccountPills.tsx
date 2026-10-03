import {
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  type CollisionDetection,
} from "@dnd-kit/core";
import type { AccountPillRow } from "@t3tools/client-runtime/accounts";
import { PlusIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { pillRowKey } from "./useAccountPills";

export const pillCollisionDetection: CollisionDetection = (input) =>
  input.pointerCoordinates ? pointerWithin(input) : rectIntersection(input);
const pillClass =
  "inline-flex max-w-64 items-center whitespace-nowrap rounded-full bg-muted px-2 py-0.5 text-2xs text-muted-foreground";

function Pill({
  row,
  text,
  disabled,
  onEdit,
}: {
  readonly row: AccountPillRow;
  readonly text: string;
  readonly disabled: boolean;
  readonly onEdit: (text: string) => void;
}) {
  const { active, attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: JSON.stringify([pillRowKey(row), text]),
    disabled,
    data: { text, rowKey: pillRowKey(row) },
  });
  return (
    <Tooltip disabled={active !== null || disabled}>
      <TooltipTrigger
        render={
          <button
            ref={setNodeRef}
            type="button"
            {...attributes}
            {...listeners}
            disabled={disabled}
            aria-label={`Edit or move ${text}`}
            onClick={() => {
              if (active === null) onEdit(text);
            }}
            className={cn(
              pillClass,
              "touch-none cursor-grab select-none active:cursor-grabbing disabled:cursor-default",
              active !== null
                ? "outline-none focus-visible:outline-none"
                : "focus-visible:outline-2 focus-visible:outline-ring",
              isDragging && "opacity-40",
            )}
          />
        }
      >
        <span className="truncate">{text}</span>
      </TooltipTrigger>
      <TooltipPopup>
        {text} · Click to edit, or drag to another row. Press Space to move with the arrow keys.
      </TooltipPopup>
    </Tooltip>
  );
}

export function AccountPills({
  row,
  disabled,
  onEdit,
}: {
  readonly row: AccountPillRow;
  readonly disabled: boolean;
  readonly onEdit: (row: AccountPillRow, text?: string) => void;
}) {
  return (
    <>
      {row.pills.map((text) => (
        <Pill
          key={text}
          row={row}
          text={text}
          disabled={disabled}
          onEdit={(value) => onEdit(row, value)}
        />
      ))}
      <Button
        variant="ghost"
        size="icon-xs"
        disabled={disabled}
        aria-label={`Add pill to ${row.label}`}
        onClick={() => onEdit(row)}
      >
        <PlusIcon />
      </Button>
    </>
  );
}

export function PillPreview({ text }: { readonly text: string }) {
  return (
    <span className={cn(pillClass, "cursor-grabbing shadow-md")}>
      <span className="truncate">{text}</span>
    </span>
  );
}

export function PillTarget({
  row,
  disabled,
  className,
  children,
}: {
  readonly row: AccountPillRow;
  readonly disabled: boolean;
  readonly className: string;
  readonly children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: pillRowKey(row), disabled });
  return (
    <div ref={setNodeRef} className={cn(className, isOver && "bg-accent/50")}>
      {children}
    </div>
  );
}

export function PillEditor({
  row,
  text,
  onSave,
  onClose,
}: {
  readonly row: AccountPillRow;
  readonly text?: string;
  readonly onSave: (pills: readonly string[]) => Promise<void>;
  readonly onClose: () => void;
}) {
  const [value, setValue] = useState(text ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formId = useId();
  const save = async (remove = false) => {
    if (pending) return;
    setError(null);
    const label = value.trim();
    if (!remove && !label) {
      setError("Enter some pill text.");
      return;
    }
    if (text !== undefined && !row.pills.includes(text)) {
      setError("This pill changed. Close this editor and try again.");
      return;
    }
    const others = row.pills.filter((pill) => pill !== text);
    if (!remove && label !== text && others.includes(label)) {
      setError("This row already has that pill.");
      return;
    }
    const pills = remove
      ? others
      : text === undefined
        ? [...others, label]
        : row.pills.map((pill) => (pill === text ? label : pill));
    setPending(true);
    try {
      await onSave(pills);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save this pill.");
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{text === undefined ? "Add a pill" : "Edit pill"}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
            className="grid gap-3"
          >
            <Input
              aria-label="Pill text"
              autoFocus
              maxLength={500}
              value={value}
              disabled={pending}
              placeholder="e.g. Amal using or Needs review"
              onChange={(event) => setValue(event.target.value)}
            />
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          {text !== undefined ? (
            <Button variant="destructive" disabled={pending} onClick={() => void save(true)}>
              Delete
            </Button>
          ) : null}
          <Button variant="outline" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
