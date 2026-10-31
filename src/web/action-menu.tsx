import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Icon } from './icons.tsx';

export interface MenuAction { id?: string; label: string; title?: string; detail?: string; hint?: string; indent?: number; select?: () => void; href?: string; disabled?: boolean; danger?: boolean; checked?: boolean; icon?: string; divider?: boolean; edit?: { label: string; select: () => void } }

// Native popovers escape scrolling containers and handle outside clicks without
// making the rest of the workspace modal. Each menu keeps its own task identity.
// The trigger defaults to a "more" button; pass children for a labelled trigger.
// A side menu opens beside its trigger, as a submenu does, and the arrow
// keys toward and away from it open and close it.
export function ActionMenu({ label, actions, children, className = 'icon-button more-button', menuClassName = '', align = 'end', disabled }: { label: string; actions: MenuAction[]; children?: ReactNode; className?: string; menuClassName?: string; align?: 'start' | 'end' | 'side'; disabled?: boolean }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const dismiss = () => menu.current?.hidePopover();
    // Close when a scrolling ancestor moves the trigger, but leave independent
    // panes (including a PDF finishing its load) and the menu itself alone.
    const scroll = (event: Event) => { if (event.target instanceof Node && event.target.contains(trigger.current) && !menu.current?.contains(event.target)) dismiss(); };
    window.addEventListener('resize', dismiss); document.addEventListener('scroll', scroll, true);
    return () => { window.removeEventListener('resize', dismiss); document.removeEventListener('scroll', scroll, true); };
  }, [open]);
  function position() {
    const panel = menu.current!, rect = trigger.current!.getBoundingClientRect();
    if (align === 'side') {
      const right = rect.right + 6, left = rect.left - panel.offsetWidth - 6;
      panel.style.left = `${right + panel.offsetWidth <= window.innerWidth - 8 || left < 8 ? Math.max(8, Math.min(right, window.innerWidth - panel.offsetWidth - 8)) : left}px`;
      panel.style.top = `${Math.max(8, Math.min(rect.top - 5, window.innerHeight - panel.offsetHeight - 8))}px`;
      return;
    }
    if (align === 'start') panel.style.minWidth = `${rect.width}px`;
    const left = align === 'start' ? rect.left : rect.right - panel.offsetWidth;
    panel.style.left = `${Math.max(8, Math.min(left, window.innerWidth - panel.offsetWidth - 8))}px`;
    const below = rect.bottom + 6, above = rect.top - panel.offsetHeight - 6;
    panel.style.top = `${below + panel.offsetHeight > window.innerHeight - 8 && above >= 8 ? above : Math.max(8, Math.min(below, window.innerHeight - panel.offsetHeight - 8))}px`;
  }
  function choices() { return Array.from(menu.current!.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)')); }
  function close() { menu.current?.hidePopover(); }
  function show(last = false) {
    menu.current?.showPopover(); position(); setOpen(true);
    const items = choices();
    (last ? items[items.length - 1] : items.find(item => item.getAttribute('aria-checked') === 'true') || items[0])?.focus();
  }
  const radio = actions.some(action => action.checked !== undefined);
  return <span className="menu-anchor">
    <button ref={trigger} type="button" className={className} aria-label={label} title={label} disabled={disabled} aria-haspopup="menu" aria-expanded={open} popoverTarget={id} onClick={event => {
      event.preventDefault(); if (menu.current?.matches(':popover-open')) close(); else show();
    }} onKeyDown={event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(event.key === 'ArrowUp'); }
      else if (align === 'side' && event.key === 'ArrowRight') { event.preventDefault(); show(); }
    }}>{children || <Icon name="more" size={18}/>}</button>
    <div ref={menu} id={id} popover="auto" role="menu" aria-label={label} className={'action-menu ' + menuClassName} onToggle={event => {
      const shown = (event.nativeEvent as ToggleEvent).newState === 'open'; setOpen(shown);
    }} onKeyDown={event => {
      // Continue normal tab order from the trigger. A surrounding mobile drawer
      // must receive Tab so its focus boundary can wrap the final row safely.
      if (event.key === 'Tab') { close(); trigger.current?.focus(); return; }
      event.stopPropagation();
      if (event.key === 'Escape' || (align === 'side' && event.key === 'ArrowLeft')) { event.preventDefault(); close(); trigger.current?.focus(); }
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); const items = choices(), current = items.indexOf(document.activeElement as HTMLElement);
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[index]?.focus();
      }
    }}>
      {actions.map(action => {
        const content = <>{action.icon ? <Icon name={action.icon} size={16}/> : radio && <span className="menu-check">{action.checked && <Icon name="check" size={16}/>}</span>}<span className="menu-label">{action.label}{action.detail && <small className="menu-detail" aria-hidden="true">{action.detail}</small>}</span>{action.hint && <span className="menu-hint" aria-hidden="true">{action.hint}</span>}{action.icon && action.checked && <span className="menu-check"><Icon name="check" size={16}/></span>}</>;
        const item = action.href
          ? <a key={action.id || action.label} role="menuitem" title={action.title} href={action.href} target="_blank" rel="noreferrer" onClick={close}>{content}</a>
          : <button key={action.id || action.label} type="button" title={action.title} role={action.checked === undefined ? 'menuitem' : 'menuitemradio'} aria-checked={action.checked} disabled={action.disabled} className={action.danger ? 'danger-text' : undefined} data-indent={action.indent || undefined} style={action.indent ? { paddingLeft: 10 + action.indent * 14 } : undefined} onClick={() => { close(); trigger.current?.focus(); action.select?.(); }}>{content}</button>;
        const row = action.edit ? <div className="menu-item-row" key={action.id || action.label}>{item}<button type="button" role="menuitem" className="icon-button paper-actions" aria-label={action.edit.label} title={action.edit.label} aria-haspopup="dialog" onClick={() => { close(); trigger.current?.focus(); action.edit?.select(); }}><Icon name="pencil" size={15}/></button></div> : item;
        return action.divider ? [<div key={action.label + '-divider'} role="separator" className="menu-separator"/>, row] : row;
      })}
    </div>
  </span>;
}
