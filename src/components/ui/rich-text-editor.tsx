'use client';

import { useEffect } from 'react';
import { Extension } from '@tiptap/core';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { FontSize, TextStyle } from '@tiptap/extension-text-style';
import { Placeholder } from '@tiptap/extensions';
import {
  Bold,
  Indent as IndentIcon,
  Italic,
  List,
  ListOrdered,
  Outdent as OutdentIcon,
  Underline as UnderlineIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

/** One Tab of indentation, in px. Mirrored by the ballot HTML sanitizer. */
const INDENT_STEP_PX = 24;
const MAX_INDENT = 8;

/**
 * Font sizes the toolbar offers. Radix `SelectItem` forbids an empty value, so
 * "inherit the editor default" is the `DEFAULT_FONT_SIZE` sentinel.
 */
const DEFAULT_FONT_SIZE = 'default';
const FONT_SIZES = [
  { label: 'Default', value: DEFAULT_FONT_SIZE },
  { label: 'Small', value: '12px' },
  { label: 'Normal', value: '14px' },
  { label: 'Medium', value: '16px' },
  { label: 'Large', value: '20px' },
  { label: 'Huge', value: '28px' },
];

/**
 * Tab / Shift-Tab indentation for plain blocks, stored as an `indent` step
 * count and rendered as `margin-left`.
 *
 * Inside a list Tab must nest the item instead, which `ListItem` already
 * handles — so this handler bows out (returns false) when the cursor is in a
 * list item, letting ProseMirror fall through to the next keymap.
 */
const Indent = Extension.create({
  name: 'blockIndent',

  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading'],
        attributes: {
          indent: {
            default: 0,
            parseHTML: (element) => {
              const margin = parseInt(element.style.marginLeft || '0', 10);
              if (!margin) return 0;
              return Math.min(MAX_INDENT, Math.round(margin / INDENT_STEP_PX));
            },
            renderHTML: (attributes) => {
              const indent = Number(attributes.indent) || 0;
              if (indent <= 0) return {};
              return { style: `margin-left: ${indent * INDENT_STEP_PX}px` };
            },
          },
        },
      },
    ];
  },

  addKeyboardShortcuts() {
    const shift = (delta: number) => () => {
      if (this.editor.isActive('listItem')) return false;
      return shiftIndent(this.editor, delta);
    };
    return { Tab: shift(1), 'Shift-Tab': shift(-1) };
  },
});

/** Nudge every indentable block in the selection by `delta` steps. */
function shiftIndent(editor: Editor, delta: number): boolean {
  const { state } = editor.view;
  const { from, to } = state.selection;
  const tr = state.tr;
  let changed = false;

  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name !== 'paragraph' && node.type.name !== 'heading') return;
    const current = Number(node.attrs.indent) || 0;
    const next = Math.max(0, Math.min(MAX_INDENT, current + delta));
    if (next === current) return;
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next });
    changed = true;
  });

  if (changed) editor.view.dispatch(tr);
  // Always swallow Tab in a plain block — the alternative is the browser moving
  // focus out of the editor mid-sentence.
  return true;
}

export interface RichTextEditorProps {
  /** Current HTML value. Changes from outside reset the document. */
  value: string;
  onChange: (html: string) => void;
  editable?: boolean;
  placeholder?: string;
  className?: string;
  /** Minimum body height, e.g. `min-h-[260px]`. */
  bodyClassName?: string;
}

/**
 * Minimal WYSIWYG editor (TipTap) offering exactly what the ballot rationale
 * needs: bold / italic / underline, font size, bullets and numbering, and Tab
 * indentation.
 *
 * The value is HTML. It is re-sanitized server-side on save — this component's
 * restraint is a UX choice, not the security boundary.
 */
export default function RichTextEditor({
  value,
  onChange,
  editable = true,
  placeholder = 'Write your rationale…',
  className,
  bodyClassName = 'min-h-[220px]',
}: RichTextEditorProps) {
  const editor = useEditor({
    // Rendered inside a client component that only mounts in the browser;
    // disabling immediate render avoids the SSR hydration mismatch warning.
    immediatelyRender: false,
    editable,
    extensions: [
      StarterKit.configure({ codeBlock: false, horizontalRule: false }),
      TextStyle,
      FontSize,
      Indent,
      Placeholder.configure({ placeholder }),
    ],
    content: value || '',
    editorProps: {
      attributes: {
        class: cn(
          'prose prose-sm dark:prose-invert max-w-none focus:outline-none px-3 py-2',
          bodyClassName,
        ),
      },
    },
    onUpdate: ({ editor: instance }) => onChange(instance.getHTML()),
  });

  // Re-sync when the value changes underneath us (a reload, a draft discarded,
  // or the initiator sending submissions back). Guarded on inequality so
  // typing — which also changes `value` — doesn't reset the cursor.
  useEffect(() => {
    if (!editor) return;
    const incoming = value || '';
    if (incoming !== editor.getHTML()) {
      editor.commands.setContent(incoming, { emitUpdate: false });
    }
  }, [value, editor]);

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editable, editor]);

  if (!editor) {
    return (
      <div
        className={cn('rounded-md border bg-background', className)}
        data-testid="rich-text-editor-loading"
      >
        <div className={cn('px-3 py-2 text-sm text-muted-foreground', bodyClassName)}>
          Loading editor…
        </div>
      </div>
    );
  }

  const activeFontSize = editor.getAttributes('textStyle').fontSize as string | undefined;
  const currentSize =
    FONT_SIZES.find((s) => s.value !== DEFAULT_FONT_SIZE && s.value === activeFontSize)
      ?.value ?? DEFAULT_FONT_SIZE;

  return (
    <div
      className={cn('rounded-md border bg-background overflow-hidden', className)}
      data-testid="rich-text-editor"
    >
      {editable && (
        <div className="flex flex-wrap items-center gap-1 border-b bg-muted/40 px-2 py-1.5">
          <ToolbarToggle
            label="Bold"
            testId="rte-bold"
            active={editor.isActive('bold')}
            onClick={() => editor.chain().focus().toggleBold().run()}
          >
            <Bold className="h-4 w-4" />
          </ToolbarToggle>
          <ToolbarToggle
            label="Italic"
            testId="rte-italic"
            active={editor.isActive('italic')}
            onClick={() => editor.chain().focus().toggleItalic().run()}
          >
            <Italic className="h-4 w-4" />
          </ToolbarToggle>
          <ToolbarToggle
            label="Underline"
            testId="rte-underline"
            active={editor.isActive('underline')}
            onClick={() => editor.chain().focus().toggleUnderline().run()}
          >
            <UnderlineIcon className="h-4 w-4" />
          </ToolbarToggle>

          <Separator orientation="vertical" className="mx-1 h-5" />

          <Select
            value={currentSize}
            onValueChange={(next) =>
              next === DEFAULT_FONT_SIZE
                ? editor.chain().focus().unsetFontSize().run()
                : editor.chain().focus().setFontSize(next).run()
            }
          >
            <SelectTrigger className="h-7 w-[110px] text-xs" data-testid="rte-font-size">
              <SelectValue placeholder="Font size" />
            </SelectTrigger>
            <SelectContent>
              {FONT_SIZES.map((size) => (
                <SelectItem key={size.label} value={size.value} className="text-xs">
                  {size.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Separator orientation="vertical" className="mx-1 h-5" />

          <ToolbarToggle
            label="Bulleted list"
            testId="rte-bullet-list"
            active={editor.isActive('bulletList')}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
          >
            <List className="h-4 w-4" />
          </ToolbarToggle>
          <ToolbarToggle
            label="Numbered list"
            testId="rte-ordered-list"
            active={editor.isActive('orderedList')}
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
          >
            <ListOrdered className="h-4 w-4" />
          </ToolbarToggle>

          <Separator orientation="vertical" className="mx-1 h-5" />

          <ToolbarToggle
            label="Decrease indent"
            testId="rte-outdent"
            onClick={() =>
              editor.isActive('listItem')
                ? editor.chain().focus().liftListItem('listItem').run()
                : shiftIndent(editor, -1)
            }
          >
            <OutdentIcon className="h-4 w-4" />
          </ToolbarToggle>
          <ToolbarToggle
            label="Increase indent"
            testId="rte-indent"
            onClick={() =>
              editor.isActive('listItem')
                ? editor.chain().focus().sinkListItem('listItem').run()
                : shiftIndent(editor, 1)
            }
          >
            <IndentIcon className="h-4 w-4" />
          </ToolbarToggle>
        </div>
      )}
      <EditorContent editor={editor} />
    </div>
  );
}

function ToolbarToggle({
  label,
  testId,
  active,
  onClick,
  children,
}: {
  label: string;
  testId: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={label}
      aria-pressed={active ?? false}
      title={label}
      data-testid={testId}
      className={cn('h-7 w-7 p-0', active && 'bg-accent/15 text-accent')}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
