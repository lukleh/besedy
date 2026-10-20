import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Markdown shown in the app (deep-search results, the correction guide), with
 * the app's typography. Raw HTML in the source is not rendered.
 */
export function MarkdownContent({ markdown }: { markdown: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        h1: ({ children }) => (
          <h1 className="mb-3 text-xl font-semibold">{children}</h1>
        ),
        h2: ({ children }) => (
          <h2 className="mt-6 mb-2 text-lg font-semibold">{children}</h2>
        ),
        h3: ({ children }) => (
          <h3 className="mt-5 mb-2 text-base font-semibold">{children}</h3>
        ),
        p: ({ children }) => <p className="my-3">{children}</p>,
        ul: ({ children }) => (
          <ul className="my-3 list-disc space-y-1 pl-5">{children}</ul>
        ),
        ol: ({ children }) => (
          <ol className="my-3 list-decimal space-y-1 pl-5">{children}</ol>
        ),
        li: ({ children }) => <li>{children}</li>,
        blockquote: ({ children }) => (
          <blockquote className="my-4 border-l-2 pl-4 text-muted-foreground">
            {children}
          </blockquote>
        ),
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="font-medium underline underline-offset-2"
          >
            {children}
          </a>
        ),
        code: ({ className, children }) => (
          <code
            className={
              className
                ? `${className} text-xs`
                : 'rounded bg-muted px-1 py-0.5 font-mono text-xs'
            }
          >
            {children}
          </code>
        ),
        pre: ({ children }) => (
          <pre className="my-4 overflow-auto rounded-md bg-background p-3 text-xs">
            {children}
          </pre>
        ),
        table: ({ children }) => (
          <div className="my-4 overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              {children}
            </table>
          </div>
        ),
        th: ({ children }) => (
          <th className="border px-2 py-1 font-semibold">{children}</th>
        ),
        td: ({ children }) => (
          <td className="border px-2 py-1 align-top">{children}</td>
        ),
      }}
    >
      {markdown}
    </ReactMarkdown>
  );
}
