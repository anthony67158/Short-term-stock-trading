import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

export function Button({
  variant = "secondary", className = "", ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" }) {
  return <button {...props} className={`button ${variant} ${className}`} />;
}

export function Input({ label, id, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; id: string }) {
  return <label className="field" htmlFor={id}><span>{label}</span><input id={id} {...props} /></label>;
}

export function Empty({ title, children }: { title: string; children: ReactNode }) {
  return <div className="empty"><h2>{title}</h2><p>{children}</p></div>;
}
