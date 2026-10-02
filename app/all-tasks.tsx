'use client';

import { useMemo, useState } from 'react';
import { Icon } from './icons';
import type { Meeting, Task } from './types';

type Filter = 'open' | 'done' | 'all';
type GroupBy = 'meeting' | 'person' | 'priority';

type Row = { task: Task; meeting: Meeting };

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 } as const;
const PRIORITY_LABEL = { high: 'Urgent', medium: 'Normal', low: 'Later' } as const;

const meetingTitle = (m: Meeting) => m.notes?.title?.trim() || 'Untitled meeting';
const shortDate = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const ownerOf = (t: Task) => t.owner?.trim() || 'Unassigned';

export function AllTasks({
  meetings,
  onUpdate,
  onRemove,
  onOpen,
}: {
  meetings: Meeting[];
  onUpdate: (meetingId: string, taskId: string, patch: Partial<Task>, markEdited?: boolean) => void;
  onRemove: (meetingId: string, taskId: string) => void;
  onOpen: (meetingId: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>('open');
  const [groupBy, setGroupBy] = useState<GroupBy>('meeting');
  const [person, setPerson] = useState('');
  const [query, setQuery] = useState('');

  const rows: Row[] = useMemo(() => meetings.flatMap((meeting) => meeting.tasks.map((task) => ({ task, meeting }))), [meetings]);
  const people = useMemo(() => [...new Set(rows.map((r) => ownerOf(r.task)))].sort(), [rows]);
  const counts = { open: rows.filter((r) => !r.task.done).length, done: rows.filter((r) => r.task.done).length };

  const q = query.trim().toLowerCase();
  const visible = rows
    .filter((r) => (filter === 'all' ? true : filter === 'done' ? r.task.done : !r.task.done))
    .filter((r) => !person || ownerOf(r.task) === person)
    .filter(
      (r) =>
        !q ||
        [r.task.task, r.task.context, r.task.owner, r.task.due, meetingTitle(r.meeting)].some((f) => f?.toLowerCase().includes(q)),
    )
    .sort(
      (a, b) =>
        Number(a.task.done) - Number(b.task.done) ||
        PRIORITY_ORDER[a.task.priority] - PRIORITY_ORDER[b.task.priority] ||
        b.meeting.createdAt - a.meeting.createdAt,
    );

  const groups = useMemo(() => {
    const map = new Map<string, { key: string; title: string; sub?: string; meeting?: Meeting; rows: Row[] }>();
    for (const r of visible) {
      const key =
        groupBy === 'meeting' ? r.meeting.id : groupBy === 'person' ? ownerOf(r.task) : r.task.priority;
      if (!map.has(key)) {
        map.set(key, {
          key,
          title:
            groupBy === 'meeting'
              ? meetingTitle(r.meeting)
              : groupBy === 'person'
                ? ownerOf(r.task)
                : PRIORITY_LABEL[r.task.priority],
          sub: groupBy === 'meeting' ? shortDate(r.meeting.createdAt) : undefined,
          meeting: groupBy === 'meeting' ? r.meeting : undefined,
          rows: [],
        });
      }
      map.get(key)!.rows.push(r);
    }
    const list = [...map.values()];
    if (groupBy === 'meeting') list.sort((a, b) => b.meeting!.createdAt - a.meeting!.createdAt);
    if (groupBy === 'person') list.sort((a, b) => (a.key === 'Unassigned' ? 1 : b.key === 'Unassigned' ? -1 : a.key.localeCompare(b.key)));
    if (groupBy === 'priority') list.sort((a, b) => PRIORITY_ORDER[a.key as Task['priority']] - PRIORITY_ORDER[b.key as Task['priority']]);
    return list;
  }, [visible, groupBy]);

  return (
    <section className="card all-tasks">
      <div className="at-head">
        <div className="tabs">
          {(
            [
              ['open', `Open`, counts.open],
              ['done', 'Done', counts.done],
              ['all', 'All', rows.length],
            ] as const
          ).map(([key, label, n]) => (
            <button key={key} className={filter === key ? 'on' : ''} onClick={() => setFilter(key)}>
              {label} <span className="pill">{n}</span>
            </button>
          ))}
        </div>
        <label className="at-search">
          <Icon name="search" size={14} />
          <input placeholder="Search tasks" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <select value={person} onChange={(e) => setPerson(e.target.value)}>
          <option value="">Everyone</option>
          {people.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
          <option value="meeting">Group by meeting</option>
          <option value="person">Group by person</option>
          <option value="priority">Group by priority</option>
        </select>
      </div>

      <div className="at-body">
        {groups.length === 0 && (
          <div className="empty">
            <div className="empty-icon">
              <Icon name="check" size={20} />
            </div>
            <p>{rows.length === 0 ? 'No tasks yet.' : 'Nothing matches these filters.'}</p>
            <p className="muted small">
              {rows.length === 0
                ? 'Tasks from every meeting you record will collect here.'
                : 'Try another filter, person or search.'}
            </p>
          </div>
        )}

        {groups.map((g) => (
          <div key={g.key} className="at-group">
            <div className="at-group-head">
              <h3>{g.title}</h3>
              {g.sub && <span className="muted small">{g.sub}</span>}
              <span className="count">{g.rows.length}</span>
              {g.meeting && (
                <button className="at-open" onClick={() => onOpen(g.meeting!.id)}>
                  Open meeting →
                </button>
              )}
            </div>
            <div className="tasks at-grid">
              {g.rows.map(({ task: t, meeting: m }) => (
                <div key={`${m.id}-${t.id}`} className={`task p-${t.priority} ${t.done ? 'done' : ''}`}>
                  <div className="task-tags">
                    <button
                      className="tag"
                      title="Click to change priority"
                      onClick={() =>
                        onUpdate(m.id, t.id, {
                          priority: t.priority === 'high' ? 'medium' : t.priority === 'medium' ? 'low' : 'high',
                        })
                      }
                    >
                      {PRIORITY_LABEL[t.priority]}
                    </button>
                    {groupBy !== 'meeting' && (
                      <button className="tag meeting-tag" title="Open this meeting" onClick={() => onOpen(m.id)}>
                        {meetingTitle(m)} · {shortDate(m.createdAt)}
                      </button>
                    )}
                    <button className="icon task-x" title="Remove" onClick={() => onRemove(m.id, t.id)}>
                      ✕
                    </button>
                  </div>
                  <textarea
                    className="task-title"
                    rows={Math.max(1, Math.ceil(t.task.length / 34))}
                    value={t.task}
                    onChange={(e) => onUpdate(m.id, t.id, { task: e.target.value })}
                  />
                  {t.context && <p className="task-ctx">{t.context}</p>}
                  <div className="task-foot">
                    <label className="chip edit">
                      <Icon name="user" size={12} />
                      <input
                        value={t.owner}
                        placeholder="Owner"
                        size={Math.max(5, t.owner.length + 1)}
                        onChange={(e) => onUpdate(m.id, t.id, { owner: e.target.value })}
                      />
                    </label>
                    <label className="chip edit">
                      <Icon name="calendar" size={12} />
                      <input
                        value={t.due}
                        placeholder="Due"
                        size={Math.max(3, t.due.length + 1)}
                        onChange={(e) => onUpdate(m.id, t.id, { due: e.target.value })}
                      />
                    </label>
                    <button
                      className={`check ${t.done ? 'on' : ''}`}
                      title={t.done ? 'Mark as open' : 'Mark as done'}
                      onClick={() => onUpdate(m.id, t.id, { done: !t.done }, false)}
                    >
                      ✓
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
