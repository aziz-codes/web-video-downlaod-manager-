import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function cx(...parts: Array<string | false | undefined | null>) {
  return parts.filter(Boolean).join(' ');
}

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="vdl-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8b7bff" />
          <stop offset="1" stopColor="#4f8bff" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill="url(#vdl-g)" />
      <path d="M25 17.5v17l14-8.5z" fill="#fff" opacity=".95" />
      <path d="M32 38v9m-6-5 6 6 6-6M20 51h24" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

const BADGE_STYLES: Record<string, string> = {
  '4K': 'bg-gradient-to-br from-amber-300 to-orange-400 text-amber-950',
  '2K': 'bg-gradient-to-br from-amber-300 to-orange-400 text-amber-950',
  FHD: 'brand-gradient text-white',
  HD: 'bg-brand-100 text-brand-700 dark:bg-brand-500/20 dark:text-brand-200',
  SD: 'bg-zinc-100 text-zinc-500 dark:bg-white/8 dark:text-zinc-400',
};

export function QualityBadge({ badge }: { badge?: string }) {
  if (!badge) return null;
  return (
    <span className={cx('rounded-md px-1.5 py-px text-[9.5px] font-extrabold tracking-wide', BADGE_STYLES[badge] ?? BADGE_STYLES.SD)}>
      {badge}
    </span>
  );
}

export function IconButton({
  label,
  children,
  className,
  tone = 'default',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; tone?: 'default' | 'danger' | 'brand' }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={cx(
        'grid size-8 shrink-0 place-items-center rounded-lg text-zinc-500 transition-colors',
        'hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/8 dark:hover:text-white',
        tone === 'danger' && 'hover:!bg-red-500/10 hover:!text-red-500',
        tone === 'brand' && 'hover:!bg-brand-500/12 hover:!text-brand-500',
        'disabled:opacity-40',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost'; size?: 'sm' | 'md' }) {
  return (
    <button
      type="button"
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-semibold transition disabled:opacity-50',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-9 px-3.5 text-[13px]',
        variant === 'primary' && 'brand-gradient text-white shadow-sm shadow-brand-500/25 hover:brightness-110',
        variant === 'secondary' &&
          'bg-zinc-100 text-zinc-800 hover:bg-zinc-200 dark:bg-white/8 dark:text-zinc-100 dark:hover:bg-white/12',
        variant === 'ghost' && 'text-brand-600 hover:bg-brand-500/10 dark:text-brand-300',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function ProgressBar({ value, tone = 'brand', indeterminate }: { value?: number; tone?: 'brand' | 'muted' | 'green'; indeterminate?: boolean }) {
  return (
    <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-zinc-200/80 dark:bg-white/8">
      {indeterminate || value === undefined ? (
        <div className="brand-gradient absolute inset-y-0 w-2/5 animate-indeterminate rounded-full" />
      ) : (
        <div
          className={cx(
            'h-full rounded-full transition-[width] duration-300 ease-out',
            tone === 'brand' && 'brand-gradient',
            tone === 'muted' && 'bg-zinc-400 dark:bg-zinc-500',
            tone === 'green' && 'bg-emerald-500',
          )}
          style={{ width: `${Math.max(2, Math.min(100, value * 100))}%` }}
        />
      )}
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative h-6 w-10 shrink-0 rounded-full transition-colors',
        checked ? 'brand-gradient' : 'bg-zinc-300 dark:bg-white/15',
      )}
    >
      <span
        className={cx(
          'absolute left-0 top-0.5 size-5 rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-[18px]' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx('rounded-2xl border border-zinc-200/80 bg-white dark:border-white/8 dark:bg-ink-900', className)}>
      {children}
    </div>
  );
}

export function StatusDot({ tone }: { tone: 'green' | 'gray' | 'amber' | 'red' }) {
  const color = { green: 'bg-emerald-500', gray: 'bg-zinc-400', amber: 'bg-amber-500', red: 'bg-red-500' }[tone];
  return (
    <span className="relative inline-flex size-2">
      {tone === 'green' && <span className={cx('absolute inset-0 animate-ping rounded-full opacity-60', color)} />}
      <span className={cx('relative inline-flex size-2 rounded-full', color)} />
    </span>
  );
}

export function Favicon({ url, size = 16 }: { url: string; size?: number }) {
  const src = `${location.origin}/_favicon/?pageUrl=${encodeURIComponent(url)}&size=${size * 2}`;
  return <img src={src} width={size} height={size} alt="" className="shrink-0" />;
}
