import {
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  type CollisionDetection,
} from "@dnd-kit/core";
import type { AccountRow } from "@t3tools/client-runtime/accounts";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function assignmentKey(account: AccountRow) {
  return JSON.stringify([account.environmentId, account.id]);
}

export function assignmentPillKey(account: AccountRow, assignee: string) {
  return JSON.stringify([account.environmentId, account.id, assignee]);
}

// Pointer drags only count inside a row; dropping outside the list cancels.
export const assignmentCollisionDetection: CollisionDetection = (input) =>
  input.pointerCoordinates ? pointerWithin(input) : rectIntersection(input);

const pillClass =
  "inline-flex items-center whitespace-nowrap rounded-full bg-muted px-2 py-0.5 text-2xs text-muted-foreground";

export function AssignmentPill({
  account,
  assignee,
  disabled,
}: {
  readonly account: AccountRow;
  readonly assignee: string;
  readonly disabled: boolean;
}) {
  const { active, attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: assignmentPillKey(account, assignee),
    disabled,
    data: { assignee, accountKey: assignmentKey(account) },
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
            aria-label={`Move ${assignee} using`}
            className={cn(
              pillClass,
              "touch-none cursor-grab select-none focus-visible:outline-2 focus-visible:outline-ring active:cursor-grabbing disabled:cursor-default",
              isDragging && "opacity-40",
            )}
          />
        }
      >
        {assignee} using
      </TooltipTrigger>
      <TooltipPopup>
        Drag to another account, or press Space to move with the arrow keys.
      </TooltipPopup>
    </Tooltip>
  );
}

export function AssignmentPreview({ assignee }: { readonly assignee: string }) {
  return <span className={cn(pillClass, "cursor-grabbing shadow-md")}>{assignee} using</span>;
}

export function AssignmentTarget({
  account,
  disabled,
  className,
  children,
}: {
  readonly account: AccountRow;
  readonly disabled: boolean;
  readonly className: string;
  readonly children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: assignmentKey(account), disabled });
  return (
    <div
      ref={setNodeRef}
      className={cn(className, isOver && "bg-accent/50 outline-1 outline-ring")}
    >
      {children}
    </div>
  );
}
