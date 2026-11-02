import { useWorkspace } from '../state/workspace-store';

interface CodeLinkProps {
  file: string | null;
  line: number | null;
  endLine?: number | null;
  label: string;
  className?: string;
  title?: string;
}

export function CodeLink({ file, line, endLine = null, label, className, title }: CodeLinkProps) {
  const { revealCode } = useWorkspace();
  if (file === null || file.trim() === '' || line === null || line <= 0) {
    return (
      <span className={className} title={title}>
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={className === undefined ? 'code-link' : `code-link ${className}`}
      title={title ?? 'Abrir en el editor y marcar la función'}
      onClick={() => {
        void revealCode(file, line, endLine);
      }}
    >
      {label}
    </button>
  );
}
