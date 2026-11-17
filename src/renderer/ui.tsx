import { AlertCircle, Check, ChevronRight, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { HttpMethod } from '../shared/types';
import { messageFrom } from './workspace';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  kind?: 'normal' | 'primary' | 'quiet' | 'danger';
  icon?: boolean;
};

export function Button({ kind = 'normal', icon, className = '', type = 'button', ...props }: ButtonProps) {
  return <button type={type} className={`button button--${kind}${icon ? ' button--icon' : ''} ${className}`} {...props} />;
}

export function IconButton({ label, ...props }: ButtonProps & { label: string }) {
  return <Button kind="quiet" aria-label={label} title={label} icon {...props} />;
}

export function Method({ method }: { method: HttpMethod }) {
  return <span className={`method method--${method.toLowerCase()}`}>{method}</span>;
}

export function Notice({ children, close, error = false }: { children: ReactNode; close?: () => void; error?: boolean }) {
  return <div className={`notice${error ? ' notice--error' : ''}`} role={error ? 'alert' : 'status'}>
    {error ? <AlertCircle size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}
    <div className="notice__message">{children}</div>
    {close && <IconButton label="关闭提示" onClick={close}><X size={14} aria-hidden="true" /></IconButton>}
  </div>;
}

export function Switch({ checked, label, disabled, change }: {
  checked: boolean; label: string; disabled?: boolean; change: (value: boolean) => void;
}) {
  return <label className="switch">
    <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={event => change(event.target.checked)} />
    <span className="switch__track" aria-hidden="true" />
    <span>{label}</span>
  </label>;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <div className="field">
    <label><span>{label}</span>{children}</label>
    {hint && <small>{hint}</small>}
  </div>;
}

export function Disclosure({ label, summary, children }: { label: string; summary: ReactNode; children: ReactNode }) {
  return <details className="disclosure">
    <summary>
      <ChevronRight className="disclosure__caret" size={15} aria-hidden="true" />
      <span>{label}</span><span className="disclosure__summary">{summary}</span>
    </summary>
    <div className="disclosure__body">{children}</div>
  </details>;
}

export interface FormSpec {
  title: string;
  submit: string;
  description?: string;
  danger?: boolean;
  children?: ReactNode;
  action: (form: FormData) => void;
}

export function Dialog({ title, children, close, className = '' }: {
  title: string; children: ReactNode; close: () => void; className?: string;
}) {
  const element = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = element.current;
    dialog?.showModal();
    dialog?.querySelector<HTMLElement>('form input, form textarea, form select')?.focus({ preventScroll: true });
    return () => { dialog?.close(); };
  }, []);
  return <dialog ref={element} className={`dialog ${className}`} aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); close(); }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
    }}>
    <header className="dialog__header">
      <h2 id={titleId}>{title}</h2>
      <IconButton label="关闭窗口" onClick={close}><X size={17} aria-hidden="true" /></IconButton>
    </header>
    {children}
  </dialog>;
}

export function FormDialog({ spec, close }: { spec: FormSpec; close: () => void }) {
  const [error, setError] = useState('');
  return <Dialog title={spec.title} close={close}>
    <form autoComplete="off" onSubmit={event => {
      event.preventDefault();
      try {
        spec.action(new FormData(event.currentTarget));
        close();
      } catch (failure) {
        setError(messageFrom(failure));
      }
    }}>
      {(spec.description || spec.children || error) && <div className="dialog__body">
        {spec.description && <p className="muted">{spec.description}</p>}
        {spec.children}
        {error && <Notice error>{error}</Notice>}
      </div>}
      <footer className="dialog__footer">
        <Button onClick={close}>取消</Button>
        <Button type="submit" kind={spec.danger ? 'danger' : 'primary'}>{spec.submit}</Button>
      </footer>
    </form>
  </Dialog>;
}

export function readField(form: FormData, name: string) {
  return String(form.get(name) ?? '').trim();
}

export function requiredField(form: FormData, name: string, label: string) {
  const text = readField(form, name);
  if (!text) throw new Error(`请输入${label}。`);
  return text;
}
