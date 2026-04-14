import { useEffect, useRef, useState } from 'react';
import type { Project } from '../../../types.ts';

type UseProjectStorageArgs = {
  project: Project;
  view: string;
  isProjectDetailView: (view: string) => boolean;
  isProjectEmpty: (project: Project) => boolean;
  toProjectListEntry: (value: Partial<Project>) => Project;
  upsertProjectListEntry: (items: Project[], nextProject: Project) => Project[];
  projectListSyncDelayMs: number;
  projectPersistDelayMs: number;
};

const PROJECTS_STATE_KEY = 'tapdance_projects_v1'; // 修改 key 名防止冲突

export function useProjectStorage({
  project,
  view,
  isProjectDetailView,
  isProjectEmpty,
  toProjectListEntry,
  upsertProjectListEntry,
  projectListSyncDelayMs,
  projectPersistDelayMs,
}: UseProjectStorageArgs) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);
  const toProjectListEntryRef = useRef(toProjectListEntry);
  const upsertProjectListEntryRef = useRef(upsertProjectListEntry);
  const isProjectDetailViewRef = useRef(isProjectDetailView);
  const isProjectEmptyRef = useRef(isProjectEmpty);

  useEffect(() => {
    toProjectListEntryRef.current = toProjectListEntry;
    upsertProjectListEntryRef.current = upsertProjectListEntry;
    isProjectDetailViewRef.current = isProjectDetailView;
    isProjectEmptyRef.current = isProjectEmpty;
  }, [toProjectListEntry, upsertProjectListEntry, isProjectDetailView, isProjectEmpty]);

  // 第一步：初始化加载（改为从浏览器 LocalStorage 读取）
  useEffect(() => {
    const loadFromLocalStorage = () => {
      try {
        const saved = localStorage.getItem(PROJECTS_STATE_KEY);
        if (saved) {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed)) {
            setProjects(parsed.map((item) => toProjectListEntryRef.current(item)));
          }
        }
      } catch (error) {
        console.error('LocalStorage load error:', error);
      } finally {
        setIsLoaded(true);
      }
    };
    loadFromLocalStorage();
  }, []);

  // 第二步：保存逻辑（改为存入浏览器 LocalStorage）
  useEffect(() => {
    if (!isLoaded) return;

    const timeoutId = window.setTimeout(() => {
      try {
        localStorage.setItem(PROJECTS_STATE_KEY, JSON.stringify(projects));
        console.log('OneFlow: Data persisted to LocalStorage');
      } catch (error) {
        console.error('LocalStorage save error:', error);
        // 这里不再 alert，防止烦人的弹窗，只会静默报错
      }
    }, projectPersistDelayMs);

    return () => window.clearTimeout(timeoutId);
  }, [isLoaded, projectPersistDelayMs, projects]);

  // 第三步：同步当前项目到列表
  useEffect(() => {
    if (!project.id) return;
    if (!isProjectDetailViewRef.current(view) && isProjectEmptyRef.current(project)) return;

    const timeoutId = window.setTimeout(() => {
      const nextProject = toProjectListEntryRef.current(project);
      setProjects((prev) => upsertProjectListEntryRef.current(prev, nextProject));
    }, projectListSyncDelayMs);

    return () => window.clearTimeout(timeoutId);
  }, [project, projectListSyncDelayMs, view]);

  return { projects, setProjects, isLoaded };
}
