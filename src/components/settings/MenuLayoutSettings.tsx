import { useMemo, useState, type CSSProperties } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  GripVertical,
  Lock,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { getVisibleServices } from "@/config/services";
import { ServiceIcon } from "@/components/ServiceIcon";
import { Button } from "@/components/ui/button";
import {
  composeMenuServices,
  isCustomMenuId,
} from "@/lib/menu-layout";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/stores/preferences-store";

function SortableMenuRow({
  id,
  name,
  url,
  icon,
  isCustom,
  editing,
  editName,
  editUrl,
  formError,
  onEditName,
  onEditUrl,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onDelete,
}: {
  id: string;
  name: string;
  url?: string;
  icon: string;
  isCustom: boolean;
  editing: boolean;
  editName: string;
  editUrl: string;
  formError: string | null;
  onEditName: (value: string) => void;
  onEditUrl: (value: string) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 1 : undefined,
    opacity: isDragging ? 0.9 : undefined,
  };

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(
        "rounded-lg border border-border/60 bg-background/80",
        isDragging && "shadow-md",
      )}
    >
      <div className="flex items-center gap-2 px-2 py-2">
        <button
          type="button"
          className="flex h-8 w-8 shrink-0 cursor-grab items-center justify-center rounded-md text-muted-foreground hover:bg-muted active:cursor-grabbing"
          aria-label={t("settings.menu.dragHandle")}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <ServiceIcon icon={icon} className="h-4 w-4 shrink-0 text-foreground/80" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{name}</p>
          {url && (
            <p className="truncate text-xs text-muted-foreground">{url}</p>
          )}
        </div>
        {isCustom ? (
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 w-8 p-0"
              aria-label={t("settings.menu.edit")}
              onClick={onStartEdit}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 w-8 p-0 text-destructive hover:text-destructive"
              aria-label={t("settings.menu.delete")}
              onClick={onDelete}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : (
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center text-muted-foreground"
            title={t("settings.menu.builtIn")}
          >
            <Lock className="h-3.5 w-3.5" aria-hidden />
            <span className="sr-only">{t("settings.menu.builtIn")}</span>
          </span>
        )}
      </div>

      {editing && (
        <div className="space-y-2 border-t border-border/60 px-3 py-3">
          <div className="space-y-1">
            <label
              htmlFor={`edit-menu-name-${id}`}
              className="text-xs font-medium text-foreground"
            >
              {t("settings.menu.nameLabel")}
            </label>
            <input
              id={`edit-menu-name-${id}`}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={editName}
              onChange={(e) => onEditName(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label
              htmlFor={`edit-menu-url-${id}`}
              className="text-xs font-medium text-foreground"
            >
              {t("settings.menu.urlLabel")}
            </label>
            <input
              id={`edit-menu-url-${id}`}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={editUrl}
              onChange={(e) => onEditUrl(e.target.value)}
              placeholder="https://"
            />
          </div>
          {formError && (
            <p className="text-xs text-destructive">{formError}</p>
          )}
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" onClick={onSaveEdit}>
              {t("settings.menu.save")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onCancelEdit}
            >
              <X className="mr-1 h-3.5 w-3.5" />
              {t("settings.menu.cancel")}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

export function MenuLayoutSettings() {
  const { t } = useTranslation();
  const menuLayout = usePreferencesStore((s) => s.menuLayout);
  const environmentMode = usePreferencesStore((s) => s.environmentMode);
  const loaded = usePreferencesStore((s) => s.loaded);
  const setMenuOrder = usePreferencesStore((s) => s.setMenuOrder);
  const addCustomMenuItem = usePreferencesStore((s) => s.addCustomMenuItem);
  const updateCustomMenuItem = usePreferencesStore((s) => s.updateCustomMenuItem);
  const removeCustomMenuItem = usePreferencesStore((s) => s.removeCustomMenuItem);

  const railServices = useMemo(
    () => composeMenuServices(getVisibleServices(), menuLayout),
    [menuLayout, environmentMode],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const [editError, setEditError] = useState<string | null>(null);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = railServices.map((service) => service.id);
    const oldIndex = ids.indexOf(String(active.id));
    const newIndex = ids.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;
    void setMenuOrder(arrayMove(ids, oldIndex, newIndex));
  };

  const handleAdd = async () => {
    setAddError(null);
    const item = await addCustomMenuItem(
      newName,
      newUrl,
      railServices.map((service) => service.id),
    );
    if (!item) {
      setAddError(t("settings.menu.invalidUrl"));
      return;
    }
    setNewName("");
    setNewUrl("");
  };

  const handleSaveEdit = async () => {
    if (!editingId) return;
    setEditError(null);
    const ok = await updateCustomMenuItem(editingId, editName, editUrl);
    if (!ok) {
      setEditError(t("settings.menu.invalidUrl"));
      return;
    }
    setEditingId(null);
  };

  return (
    <section className="max-w-xl space-y-8">
      <div>
        <h2 className="text-lg font-semibold text-foreground">
          {t("settings.menu.title")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.menu.help")}
        </p>
      </div>

      <div className="space-y-3">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={railServices.map((service) => service.id)}
            strategy={verticalListSortingStrategy}
          >
            <ul className="flex flex-col gap-1.5">
              {railServices.map((service) => {
                const custom = isCustomMenuId(service.id);
                return (
                  <SortableMenuRow
                    key={service.id}
                    id={service.id}
                    name={service.name}
                    url={custom ? service.url : undefined}
                    icon={service.icon}
                    isCustom={custom}
                    editing={editingId === service.id}
                    editName={editName}
                    editUrl={editUrl}
                    formError={editingId === service.id ? editError : null}
                    onEditName={setEditName}
                    onEditUrl={setEditUrl}
                    onStartEdit={() => {
                      setEditingId(service.id);
                      setEditName(service.name);
                      setEditUrl(service.url);
                      setEditError(null);
                    }}
                    onCancelEdit={() => {
                      setEditingId(null);
                      setEditError(null);
                    }}
                    onSaveEdit={() => void handleSaveEdit()}
                    onDelete={() => {
                      if (editingId === service.id) setEditingId(null);
                      void removeCustomMenuItem(service.id);
                    }}
                  />
                );
              })}
            </ul>
          </SortableContext>
        </DndContext>

        <div className="space-y-2 rounded-lg border border-border/60 bg-background/60 p-3">
          <p className="text-sm font-medium text-foreground">
            {t("settings.menu.addTitle")}
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <label
                htmlFor="add-menu-name"
                className="text-xs font-medium text-foreground"
              >
                {t("settings.menu.nameLabel")}
              </label>
              <input
                id="add-menu-name"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={newName}
                disabled={!loaded}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t("settings.menu.namePlaceholder")}
              />
            </div>
            <div className="space-y-1">
              <label
                htmlFor="add-menu-url"
                className="text-xs font-medium text-foreground"
              >
                {t("settings.menu.urlLabel")}
              </label>
              <input
                id="add-menu-url"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={newUrl}
                disabled={!loaded}
                onChange={(e) => setNewUrl(e.target.value)}
                placeholder="https://"
              />
            </div>
          </div>
          {addError && <p className="text-xs text-destructive">{addError}</p>}
          <Button
            type="button"
            size="sm"
            disabled={!loaded}
            onClick={() => void handleAdd()}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            {t("settings.menu.add")}
          </Button>
        </div>
      </div>
    </section>
  );
}
