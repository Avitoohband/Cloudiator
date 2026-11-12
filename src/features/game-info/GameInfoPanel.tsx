'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ClipboardEvent, KeyboardEvent } from 'react';
import { GameInfoEditor } from './GameInfoEditor';
import { editGameInfo, loadDraftGameInfo, loadPublishedGameInfo, type GameInfoPages, type GameInfoSnapshot, type GameInfoTab } from './game-info-client';
import { futureUpdates, wikiTopics } from './public-content';
import styles from './game-info.module.css';

const tabs = [{ id: 'wiki', label: 'Wiki' }, { id: 'future', label: 'Future Updates' }] as const;
const stopCopy = (event: ClipboardEvent) => event.preventDefault();
const wikiFallback = wikiTopics.map(({ text, ...entry }) => ({ ...entry, body: text }));
const futureIds = ['parties', 'friends', 'items', 'seasonal'];
const futureFallback = futureUpdates.map(({ title, text }, index) => ({ id: futureIds[index], title, body: text, patch: undefined }));

export function GameInfoPanel({ id, onClose, update, fixture, editorAccount, onDirty, allowDiscard }: {
  id: string;
  onClose(): void;
  update?: { number: string; reload(): void };
  fixture: boolean;
  editorAccount: string | null;
  onDirty(dirty: boolean): void;
  allowDiscard(): boolean;
}) {
  const [active, setActive] = useState(0);
  const [topic, setTopic] = useState('combat');
  const panel = useRef<HTMLElement>(null);
  const topics = useRef<HTMLDivElement>(null);
  const tabButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const [pages, setPages] = useState<GameInfoPages>({});
  const [canEdit, setCanEdit] = useState(false);
  const [editing, setEditing] = useState<GameInfoSnapshot | null>(null);
  const [loadingEditor, setLoadingEditor] = useState(false);
  const [editorFailed, setEditorFailed] = useState(false);
  const pending = useRef(0);
  const wiki = pages.wiki?.document.entries ?? wikiFallback;
  const future = pages.future?.document.entries ?? futureFallback;
  const article = wiki.find(item => item.id === topic) ?? wiki[0];
  const currentTab = tabs[active];
  const tabId = (key: string) => `${id}-${key}-tab`;
  const panelId = (key: string) => `${id}-${key}-panel`;
  const optionId = (key: string) => `${id}-topic-${key}`;

  useEffect(() => {
    // Scroll only the list (not the panel) so the chosen row is inside its visible area.
    const list = topics.current;
    const option = article && list?.querySelector<HTMLElement>(`[id="${optionId(article.id)}"]`);
    if (!list || !option) return;
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [article?.id, active, pages.wiki, editing]);

  function moveTopic(event: KeyboardEvent<HTMLDivElement>) {
    const at = Math.max(0, wiki.findIndex(item => item.id === article?.id));
    const next = event.key === 'ArrowDown' ? Math.min(at + 1, wiki.length - 1) : event.key === 'ArrowUp' ? Math.max(at - 1, 0)
      : event.key === 'Home' ? 0 : event.key === 'End' ? wiki.length - 1 : null;
    if (next === null || !wiki[next]) return;
    event.preventDefault();
    setTopic(wiki[next].id);
  }

  useEffect(() => {
    let alive = true;
    if (fixture) {
      // `?mode=fixture&info=draft` previews the drafts in docs/game-info (fixture builds only).
      if (new URLSearchParams(window.location.search).get('info') === 'draft') void loadDraftGameInfo().then(next => {
        if (alive) setPages(next);
      }, () => {});
      return () => { alive = false; };
    }
    void loadPublishedGameInfo().then(next => {
      if (alive) setPages(previous => ({ ...next, ...previous }));
    }, () => {});
    if (editorAccount) void editGameInfo({ tab: 'wiki', action: 'read' }).then(result => {
      if (alive) setCanEdit(result.ok);
    });
    return () => { alive = false; pending.current++; };
  }, [fixture, editorAccount]);

  useLayoutEffect(() => {
    const element = panel.current;
    const chip = element?.parentElement;
    if (!element || !chip) return;
    const viewport = window.visualViewport;
    const fit = () => {
      const bottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
      const available = Math.max(0, Math.floor(bottom - element.getBoundingClientRect().top - 12));
      element.style.setProperty('--game-info-height', `${available}px`);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(chip);
    window.addEventListener('resize', fit);
    viewport?.addEventListener('resize', fit);
    tabButtons.current[0]?.focus();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', fit);
      viewport?.removeEventListener('resize', fit);
    };
  }, []);

  function moveTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : event.key === 'ArrowRight' ? (index + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : null;
    if (next === null) return;
    event.preventDefault();
    changeTab(next);
    tabButtons.current[next]?.focus();
  }

  function changeTab(index: number) {
    pending.current++;
    setActive(index);
    setLoadingEditor(false);
    setEditorFailed(false);
  }

  async function beginEdit(tab: GameInfoTab) {
    const request = ++pending.current;
    setLoadingEditor(true);
    setEditorFailed(false);
    const result = await editGameInfo({ tab, action: 'read' });
    if (request !== pending.current) return;
    setLoadingEditor(false);
    if (result.ok) setEditing(result);
    else setEditorFailed(true);
  }

  function closeEditor() {
    setEditing(null);
    requestAnimationFrame(() => tabButtons.current[active]?.focus());
  }

  return <section ref={panel} id={id} role="dialog" aria-labelledby={`${id}-title`} className={styles.panel}>
    <header className={styles.head}>
      <h2 id={`${id}-title`}>Game Info</h2>
      <button type="button" className={styles.close} aria-label="Close Game Info" onClick={onClose}>×</button>
    </header>
    {update && <div className={styles.update} role="status">
      <p>Patch {update.number} is out</p>
      <button type="button" onClick={update.reload}>Reload</button>
    </div>}
    <div role="tablist" aria-label="Game information" className={styles.tabs}>
      {tabs.map((tab, index) => <button key={tab.id} id={tabId(tab.id)} type="button" role="tab" aria-selected={active === index}
        aria-controls={panelId(tab.id)} tabIndex={active === index ? 0 : -1} ref={button => { tabButtons.current[index] = button; }}
        disabled={editing !== null} onClick={() => changeTab(index)} onKeyDown={event => moveTab(event, index)}>{tab.label}</button>)}
    </div>
    <section id={panelId('wiki')} role="tabpanel" aria-labelledby={tabId('wiki')} className={styles.body} hidden={active !== 0 || editing !== null} tabIndex={0}>
      <div ref={topics} role="listbox" aria-label="Wiki topics" tabIndex={0} className={styles.topics}
        aria-activedescendant={article ? optionId(article.id) : undefined} onKeyDown={moveTopic}>
        {wiki.map(item => {
          const chosen = item.id === article?.id;
          return <div key={item.id} id={optionId(item.id)} role="option" aria-selected={chosen} className={styles.topic}
            onClick={() => setTopic(item.id)}>
            <span aria-hidden="true" className={styles.mark}>{chosen ? '✓' : ''}</span>{item.title}
          </div>;
        })}
      </div>
      {article && <article className={`${styles.entry} ${styles.readText}`} onCopy={stopCopy} aria-labelledby={`${id}-article`}>
        <h3 id={`${id}-article`}>{article.title}</h3>
        <p>{article.body}</p>
      </article>}
      <section aria-labelledby={`${id}-videos`} className={styles.videos}>
        <h3 id={`${id}-videos`}>YouTube guides</h3>
        <ul>{([0, 1] as const).map(index => {
          const link = pages.wiki?.document.videos?.[index];
          return <li className={styles.entry} key={index}>
            {link ? <a href={link} target="_blank" rel="noopener noreferrer">Watch video {index + 1} on YouTube</a>
              : <><strong>Video {index + 1}</strong><span>In planning</span></>}
          </li>;
        })}</ul>
      </section>
    </section>
    <section id={panelId('future')} role="tabpanel" aria-labelledby={tabId('future')} className={styles.body} hidden={active !== 1 || editing !== null} tabIndex={0}>
      <div className={styles.readText} onCopy={stopCopy}>
        <p className={styles.intro}>Plans for upcoming patches. Patch numbers appear when confirmed.</p>
        <ul className={styles.roadmap}>{future.map(item => <li className={styles.entry} key={item.id}>
          <h3>{item.title}</h3>
          {item.patch && <p>Patch {item.patch}</p>}
          <p>{item.body}</p>
        </li>)}</ul>
      </div>
    </section>
    {editing ? <GameInfoEditor tab={currentTab.id} initial={editing} selectedId={article?.id ?? ''} publishedVersion={pages[currentTab.id]?.version}
      onDirty={onDirty} onClose={() => { if (allowDiscard()) closeEditor(); }}
      onPublished={snapshot => { setPages(previous => ({ ...previous, [currentTab.id]: snapshot })); closeEditor(); }} />
      : canEdit && <footer className={styles.editBar}>
        {editorFailed && <p role="alert">The draft could not be opened.</p>}
        <button type="button" disabled={loadingEditor} onClick={() => void beginEdit(currentTab.id)}>Edit {currentTab.label}</button>
      </footer>}
  </section>;
}
