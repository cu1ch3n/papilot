import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons.tsx';
import { ChipSelect } from './chip-select.tsx';
import { keepDialogFocus } from './focus.ts';
import { LANGUAGES, browserLanguage, setLanguage, t, useLanguage, type LanguageChoice } from './i18n.ts';
import { setNotifications, testNotification, useNotifications } from './notifications.ts';
import { browserStorage } from './storage.ts';
import type { Theme } from './theme.tsx';
import { ShortcutSettings } from './shortcut-settings.tsx';
import { AboutSettings, LicenseSettings } from './about-settings.tsx';
import info from 'virtual:papilot-info';
import { DiagnosticsSettings, type DiagnosticsSettingsProps } from './diagnostics-settings.tsx';
import { UpdateSettings, versionLabel, type UpdateApi } from './update-notice.tsx';
import { SkillLibraryPanel, type SkillLibraryControls, type SkillLibraryOptions } from './skill-library.tsx';

type SettingsPage = 'general' | 'shortcuts' | 'about' | 'licenses' | 'diagnostics' | 'skills' | 'updates';

// The review page reads this key: "off" stops it from looking up the
// bibliography entries a change adds or modifies in Crossref, DBLP and arXiv.
const REFERENCE_CHECKS = 'latex-review:references';

// Browser preferences and workspace management share one sidebar entry.
export function SettingsDialog({ theme, onTheme, onClose, onPeople, onSignOut, accountName, diagnostics, skills, updates, initialPage = 'general' }: { theme: Theme; onTheme: (theme: Theme) => void; onClose: () => void; onPeople?: () => void; onSignOut?: () => void; accountName?: string; diagnostics?: DiagnosticsSettingsProps; skills?: SkillLibraryOptions; updates?: UpdateApi; initialPage?: 'general' | 'shortcuts' }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const skillControls = useRef<SkillLibraryControls>(null);
  const { choice } = useLanguage();
  const notifications = useNotifications();
  const [page, setPage] = useState<SettingsPage>(initialPage);
  const previousPage = useRef<SettingsPage>(initialPage);
  const [asking, setAsking] = useState(false), [test, setTest] = useState<'' | 'sent' | 'failed'>('');
  const [checkReferences, setCheckReferences] = useState(() => browserStorage.getItem(REFERENCE_CHECKS) !== 'off');
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const element = dialog.current!;
    element.showModal(); element.querySelector<HTMLInputElement>('input:checked')?.focus();
    return () => { element.close(); if (opener?.isConnected && opener.getClientRects().length) opener.focus(); };
  }, []);
  useEffect(() => {
    if (previousPage.current === page) return;
    const previous = previousPage.current;
    previousPage.current = page;
    const element = dialog.current!;
    element.querySelector('.settings-dialog')!.scrollTop = 0;
    const returning = page === 'general' || (page === 'about' && previous === 'licenses');
    const target = returning ? element.querySelector<HTMLElement>(`[data-settings-page="${previous}"]`) : null;
    (target || element.querySelector<HTMLElement>('#settings-title'))?.focus();
  }, [page]);
  const granted = notifications.permission === 'granted', on = notifications.on && granted;
  const blocked = notifications.permission === 'unsupported' ? t('This browser cannot show notifications.')
    : notifications.permission === 'insecure' ? t('Browsers show notifications only on HTTPS or localhost. Open Papilot at a secure address to use them.')
    : notifications.permission === 'denied' ? t('Notifications are blocked for this site. Allow them in the browser’s site settings, then turn them on here.') : '';
  async function toggle(value: boolean) {
    setAsking(true); setTest('');
    try { await setNotifications(value); } finally { setAsking(false); }
  }
  const browserName = LANGUAGES.find(item => item.id === browserLanguage())!.name;
  const close = () => { if (page === 'skills') skillControls.current?.cancel(); else onClose(); };
  return <dialog ref={dialog} className="modal-backdrop" aria-labelledby="settings-title" onKeyDown={keepDialogFocus} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <section className={'modal settings-dialog' + (page === 'skills' ? ' settings-skills' : '')}>
      {page === 'skills' && skills ? <SkillLibraryPanel {...skills} controls={skillControls} onBack={() => setPage('general')} onClose={onClose}/> : <>
      <button className="modal-close icon-button" aria-label={t('Close')} onClick={onClose}><Icon name="close"/></button>
      {page !== 'general' && <button type="button" className="settings-back" onClick={() => setPage(page === 'licenses' ? 'about' : 'general')}><Icon name="chevronLeft" size={14}/>{page === 'licenses' ? t('About Papilot') : t('Settings')}</button>}
      <h2 id="settings-title" tabIndex={-1}>{page === 'shortcuts' ? t('Keyboard shortcuts') : page === 'about' ? t('About Papilot') : page === 'licenses' ? t('Third-party licenses') : page === 'diagnostics' ? t('Runtime & diagnostics') : page === 'updates' ? t('Updates') : t('Settings')}</h2>
      {page === 'shortcuts' ? <ShortcutSettings/> : page === 'about' ? <AboutSettings onLicenses={() => setPage('licenses')}/> : page === 'licenses' ? <LicenseSettings/> : page === 'diagnostics' && diagnostics ? <DiagnosticsSettings {...diagnostics}/> : page === 'updates' && updates ? <UpdateSettings api={updates}/> : <>
      <h3 className="settings-section-title settings-preferences-title">{t('Preferences')}</h3>
      <div className="settings-row">
        <span className="settings-name" id="settings-appearance">{t('Appearance')}</span>
        <div className="segmented" role="radiogroup" aria-labelledby="settings-appearance">
          {(['light', 'dark', 'system'] as const).map(value => <label key={value} className={theme === value ? 'checked' : undefined}>
            <input type="radio" name="theme" value={value} checked={theme === value} onChange={() => onTheme(value)}/>
            <Icon name={value === 'light' ? 'sun' : value === 'dark' ? 'moon' : 'monitor'} size={15}/>{value === 'light' ? t('Light') : value === 'dark' ? t('Dark') : t('System')}
          </label>)}
        </div>
      </div>
      <div className="settings-row">
        <span className="settings-name">{t('Language')}</span>
        <ChipSelect label={t('Language')} value={choice} onChange={value => setLanguage(value as LanguageChoice)}
          options={[{ value: 'system', label: t('Browser default ({language})', { language: browserName }) }, ...LANGUAGES.map(item => ({ value: item.id, label: item.name }))]}/>
      </div>
      <div className="settings-row settings-notifications">
        <div className="settings-text">
          <label className="settings-name" htmlFor="settings-notify">{t('Notifications')}</label>
          <p id="settings-notify-detail">{blocked || t('Notify me when a task needs my reply, its review is ready, or it stops with an error, while Papilot is in the background.')}</p>
        </div>
        <input id="settings-notify" type="checkbox" role="switch" className="switch" aria-describedby="settings-notify-detail" checked={on} disabled={asking || (Boolean(blocked) && !on)} onChange={event => void toggle(event.target.checked)}/>
      </div>
      {on && <div className="settings-test">
        <button type="button" className="button secondary compact" onClick={() => setTest(testNotification() ? 'sent' : 'failed')}><Icon name="bell" size={14}/>{t('Send a test notification')}</button>
        {test && <span role="status">{test === 'sent' ? t('Sent. If nothing appeared, allow notifications for this browser in your system settings.') : t('This browser could not show the notification.')}</span>}
      </div>}
      <div className="settings-row settings-toggle">
        <div className="settings-text">
          <label className="settings-name" htmlFor="settings-references">{t('Check references online')}</label>
          <p id="settings-references-detail">{t('When a change adds or edits a bibliography entry, look up its title, authors, year and DOI in Crossref, DBLP and arXiv. Nothing else from your paper is sent.')}</p>
        </div>
        <input id="settings-references" type="checkbox" role="switch" className="switch" aria-describedby="settings-references-detail" checked={checkReferences} onChange={event => { setCheckReferences(event.target.checked); browserStorage.setItem(REFERENCE_CHECKS, event.target.checked ? 'on' : 'off'); }}/>
      </div>
      <div className="settings-navigation">
        {skills && <button type="button" className="settings-navigation-row" data-settings-page="skills" onClick={() => setPage('skills')}><Icon name="spark" size={17}/><span>{t('Skills')}</span><Icon name="chevronRight" size={15}/></button>}
        <button type="button" className="settings-navigation-row" data-settings-page="shortcuts" onClick={() => setPage('shortcuts')}><Icon name="keyboard" size={17}/><span>{t('Keyboard shortcuts')}</span><Icon name="chevronRight" size={15}/></button>
        {onPeople && <button type="button" className="settings-navigation-row" aria-haspopup="dialog" onClick={onPeople}><Icon name="people" size={17}/><span>{t('People')}</span><Icon name="chevronRight" size={15}/></button>}
        {diagnostics && <button type="button" className="settings-navigation-row" data-settings-page="diagnostics" onClick={() => setPage('diagnostics')}><Icon name="monitor" size={17}/><span>{t('Runtime & diagnostics')}</span><Icon name="chevronRight" size={15}/></button>}
        {updates && <button type="button" className="settings-navigation-row" data-settings-page="updates" onClick={() => setPage('updates')}><Icon name="arrowUp" size={17}/><span>{t('Updates')}</span><Icon name="chevronRight" size={15}/></button>}
        <button type="button" className="settings-navigation-row" data-settings-page="about" onClick={() => setPage('about')}><Icon name="info" size={17}/><span>{t('About Papilot')}</span><small>v{versionLabel(info.version)}</small><Icon name="chevronRight" size={15}/></button>
        {onSignOut && <button type="button" className="settings-navigation-row" onClick={onSignOut}><Icon name="signOut" size={17}/><span>{t('Sign out')}</span>{accountName && <small>{accountName}</small>}</button>}
      </div>
      <footer className="settings-footer"><span>Papilot · {info.license}</span><a href={info.repository} target="_blank" rel="noopener noreferrer"><Icon name="github" size={15}/>GitHub<Icon name="external" size={12}/><span className="sr-only">{t('Opens in a new tab')}</span></a></footer>
      </>}
      </>}
    </section>
  </dialog>;
}
