import { defineStore } from 'pinia';
import { graphqlClient, LIFT_PLAN_QUERY } from './graphql';

export type StepStatus = 'pending' | 'passed' | 'blocked';
export type SignDecision = 'accepted' | 'reserved';
export type DecisionStatus = 'valid' | 'superseded' | 'invalidated';

export type Comment = {
  id: string;
  author: string;
  role: string;
  content: string;
  status: 'open' | 'resolved';
  stepId: string;
};

export type LiftStep = {
  id: string;
  title: string;
  time: string;
  loadRate: number;
  clearance: number;
  wind: number;
  radius: number;
  boom: number;
  status: StepStatus;
  note: string;
};

export type Reviewer = {
  id: string;
  name: string;
  team: string;
  role: string;
  scope: string;
};

export type SignRecord = {
  personId: string;
  personName: string;
  team: string;
  role: string;
  scope: string;
  decision: SignDecision;
  reservation?: string;
  revision: number;
  basisHash: string;
  signedAt: string;
};

export type DecisionLogEntry = SignRecord & {
  id: string;
  status: DecisionStatus;
  supersededAt?: string;
  invalidatedAt?: string;
  invalidReason?: string;
};

export type PublishedVersion = {
  revision: number;
  lockedAt: string;
  steps: LiftStep[];
  comments: Comment[];
  signatures: SignRecord[];
  decisionLog: DecisionLogEntry[];
};

const initialSteps: LiftStep[] = [
  { id: 'S-01', title: '吊车支腿就位与地耐力复核', time: '07:30', loadRate: 0, clearance: 4.2, wind: 3.4, radius: 18, boom: 42, status: 'passed', note: '支腿钢板 2.4m × 2.4m，已完成压实度复检。' },
  { id: 'S-02', title: '空钩回转与障碍物净空检查', time: '08:10', loadRate: 28, clearance: 1.2, wind: 4.1, radius: 22, boom: 46, status: 'blocked', note: '东侧临时配电箱侵入回转半径 0.6m。' },
  { id: 'S-03', title: '桁架试吊离地 300mm', time: '08:45', loadRate: 76, clearance: 2.8, wind: 5.2, radius: 20, boom: 44, status: 'pending', note: '需安全员确认吊点受力均匀。' },
  { id: 'S-04', title: '主吊回转至安装轴线', time: '09:20', loadRate: 83, clearance: 1.8, wind: 6.8, radius: 24, boom: 48, status: 'pending', note: '风速超过 8m/s 立即停止。' },
  { id: 'S-05', title: '双机抬吊姿态调整', time: '10:05', loadRate: 92, clearance: 1.3, wind: 7.2, radius: 27, boom: 52, status: 'blocked', note: '辅吊荷载率超过方案控制值。' },
  { id: 'S-06', title: '就位、临时固定与摘钩', time: '10:50', loadRate: 68, clearance: 2.1, wind: 5.6, radius: 21, boom: 45, status: 'pending', note: '四组临时螺栓到位后方可摘钩。' }
];

const initialComments: Comment[] = [
  { id: 'C-11', author: '周工', role: '安全', content: 'S-02 回转路径与配电箱净空不足，请调整吊车站位或迁移配电箱。', status: 'open', stepId: 'S-02' },
  { id: 'C-12', author: '刘明', role: '设备', content: '辅吊支腿下方需要补充路基板，提供地耐力实测记录。', status: 'open', stepId: 'S-05' },
  { id: 'C-13', author: '陈晓', role: '总包', content: '同意主吊选型，建议把第三检查点前移到试吊阶段。', status: 'resolved', stepId: 'S-03' }
];

const initialReviewers: Reviewer[] = [
  { id: 'GC', name: '陈晓', team: '总包项目部', role: '总包负责人', scope: '吊装工序与场地移交' },
  { id: 'SB', name: '刘明', team: '设备管理', role: '设备负责人', scope: '吊车参数与支腿地基' },
  { id: 'AQ', name: '周工', team: '安全监督', role: '安全监督', scope: '净空、风速与警戒区' },
  { id: 'FA', name: '赵磊', team: '方案工程', role: '方案工程师', scope: '载荷计算与路径参数' }
];

const cacheKey = 'yy58-lift-plan-draft';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function buildPlanBasis(steps: LiftStep[], comments: Comment[]) {
  const basis = {
    steps: steps.map((step) => ({
      id: step.id,
      loadRate: step.loadRate,
      clearance: step.clearance,
      wind: step.wind,
      radius: step.radius,
      boom: step.boom,
      status: step.status,
      note: step.note.trim()
    })),
    conflictHandling: comments.map((comment) => ({
      id: comment.id,
      stepId: comment.stepId,
      content: comment.content.trim(),
      status: comment.status
    }))
  };
  return JSON.stringify(basis);
}

function getConflicts(steps: LiftStep[]) {
  return steps.flatMap((step) => {
    const issues: string[] = [];
    if (step.loadRate > 90) issues.push(`荷载率 ${step.loadRate}% 超过 90% 阈值`);
    if (step.clearance < 1.5) issues.push(`净空 ${step.clearance}m 小于 1.5m`);
    if (step.wind > 8) issues.push(`风速 ${step.wind}m/s 超过暂停值`);
    if (step.radius > step.boom * 0.62) issues.push('工作半径接近额定幅度');
    return issues.map((message, index) => ({
      id: `${step.id}-${index}`,
      stepId: step.id,
      title: step.title,
      message,
      severity: step.status === 'blocked' ? 'high' : 'medium'
    }));
  });
}

function normalizeSignatures(saved: unknown): (SignRecord | null)[] {
  const values = Array.isArray(saved) ? saved : [];
  return initialReviewers.map((reviewer) => {
    const record = values.find((item) => item && item.personId === reviewer.id);
    return record ? clone(record) : null;
  });
}

const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(cacheKey) : null;
const legacySaved = stored ? JSON.parse(stored) : null;

const savedSteps = Array.isArray(legacySaved?.steps) ? clone(legacySaved.steps) as LiftStep[] : clone(initialSteps);
const savedComments = Array.isArray(legacySaved?.comments) ? clone(legacySaved.comments) as Comment[] : clone(initialComments);
const savedPublishedVersions = Array.isArray(legacySaved?.publishedVersions)
  ? clone(legacySaved.publishedVersions) as PublishedVersion[]
  : [];
const savedRevision = typeof legacySaved?.revision === 'number' ? legacySaved.revision : 4;
// 旧版演示数据可能在没有签字归档时就被标记为锁定；新版门禁要求补齐四人会签。
const savedLocked = Boolean(legacySaved?.locked) && savedPublishedVersions.some((version) => version.revision === savedRevision);

export const useLiftStore = defineStore('lift-plan', {
  state: () => ({
    steps: savedSteps,
    comments: savedComments,
    reviewers: clone(initialReviewers),
    signatures: normalizeSignatures(legacySaved?.signatures) as (SignRecord | null)[],
    decisionLog: Array.isArray(legacySaved?.decisionLog) ? clone(legacySaved.decisionLog) as DecisionLogEntry[] : [],
    publishedVersions: savedPublishedVersions,
    selectedStepId: typeof legacySaved?.selectedStepId === 'string' ? legacySaved.selectedStepId : 'S-02',
    revision: savedRevision,
    locked: savedLocked,
    lockedAt: typeof legacySaved?.lockedAt === 'string' && savedLocked ? legacySaved.lockedAt : undefined,
    basisHash: typeof legacySaved?.basisHash === 'string' ? legacySaved.basisHash : buildPlanBasis(savedSteps, savedComments),
    viewBookmarks: Array.isArray(legacySaved?.viewBookmarks) ? legacySaved.viewBookmarks : ['主吊全景', '东侧障碍', '安装轴线'],
    activeBookmark: typeof legacySaved?.activeBookmark === 'string' ? legacySaved.activeBookmark : '主吊全景'
  }),
  getters: {
    selectedStep(state): LiftStep {
      return state.steps.find((step) => step.id === state.selectedStepId) ?? state.steps[0];
    },
    conflicts(state) {
      return getConflicts(state.steps);
    },
    openComments(state) {
      return state.comments.filter((comment) => comment.status === 'open');
    },
    acceptedSignatures(state): SignRecord[] {
      return state.signatures.filter((signature): signature is SignRecord => signature?.decision === 'accepted');
    },
    reservedSignatures(state): SignRecord[] {
      return state.signatures.filter((signature): signature is SignRecord => signature?.decision === 'reserved' && Boolean(signature.reservation?.trim()));
    },
    canLock(state): boolean {
      return !state.locked
        && state.signatures.length === initialReviewers.length
        && state.signatures.every((signature) => signature?.decision === 'accepted' && signature.basisHash === state.basisHash)
        && getConflicts(state.steps).length === 0
        && state.comments.every((comment) => comment.status === 'resolved');
    },
    readiness(state): number {
      const acceptedScore = (state.signatures.filter((signature) => signature?.decision === 'accepted').length / initialReviewers.length) * 50;
      const passedScore = (state.steps.filter((step) => step.status === 'passed').length / state.steps.length) * 20;
      const conflictScore = getConflicts(state.steps).length === 0 ? 15 : 0;
      const commentScore = state.comments.every((comment) => comment.status === 'resolved') ? 15 : 0;
      return Math.round(acceptedScore + passedScore + conflictScore + commentScore);
    }
  },
  actions: {
    selectStep(id: string) {
      this.selectedStepId = id;
      this.persist();
    },
    updateStep(patch: Partial<LiftStep>): boolean {
      if (this.locked) return false;
      const index = this.steps.findIndex((step) => step.id === this.selectedStepId);
      if (index < 0) return false;

      const current = this.steps[index];
      const next = { ...current, ...patch };
      const changed = JSON.stringify(current) !== JSON.stringify(next);
      if (!changed) return false;

      this.steps.splice(index, 1, next);
      this.basisHash = buildPlanBasis(this.steps, this.comments);
      this.invalidateSignatures('步骤参数、步骤状态或现场控制说明已修改');
      this.persist();
      return true;
    },
    setStatus(status: StepStatus) {
      this.updateStep({ status });
    },
    addComment(content: string, author = '王工', role = '方案'): boolean {
      const trimmed = content.trim();
      if (!trimmed || this.locked) return false;
      this.comments.unshift({
        id: `C-${Date.now()}`,
        author,
        role,
        content: trimmed,
        status: 'open',
        stepId: this.selectedStepId
      });
      this.basisHash = buildPlanBasis(this.steps, this.comments);
      this.invalidateSignatures('冲突处理意见已新增');
      this.persist();
      return true;
    },
    resolveComment(id: string): boolean {
      if (this.locked) return false;
      const item = this.comments.find((comment) => comment.id === id);
      if (!item || item.status === 'resolved') return false;
      item.status = 'resolved';
      this.basisHash = buildPlanBasis(this.steps, this.comments);
      this.invalidateSignatures('冲突处理意见状态已更新');
      this.persist();
      return true;
    },
    submitSignature(personId: string, decision: SignDecision, reservation = ''): boolean {
      if (this.locked) return false;
      const reviewer = this.reviewers.find((person) => person.id === personId);
      const trimmedReservation = reservation.trim();
      if (!reviewer || (decision === 'reserved' && !trimmedReservation)) return false;

      const now = new Date().toISOString();
      this.decisionLog = this.decisionLog.map((entry) => entry.status === 'valid' && entry.personId === personId
        ? { ...entry, status: 'superseded', supersededAt: now }
        : entry
      );

      const record: SignRecord = {
        personId: reviewer.id,
        personName: reviewer.name,
        team: reviewer.team,
        role: reviewer.role,
        scope: reviewer.scope,
        decision,
        revision: this.revision,
        basisHash: this.basisHash,
        signedAt: now,
        ...(decision === 'reserved' ? { reservation: trimmedReservation } : {})
      };

      const index = this.reviewers.findIndex((person) => person.id === personId);
      this.signatures.splice(index, 1, record);
      this.decisionLog.unshift({ ...record, id: `D-${Date.now()}-${personId}`, status: 'valid' });
      this.persist();
      return true;
    },
    invalidateSignatures(reason: string) {
      if (!this.signatures.some(Boolean)) return;
      const now = new Date().toISOString();
      this.signatures = this.reviewers.map(() => null);
      this.decisionLog = this.decisionLog.map((entry) => entry.status === 'valid'
        ? { ...entry, status: 'invalidated', invalidatedAt: now, invalidReason: reason }
        : entry
      );
    },
    lockPlan(): boolean {
      if (!this.canLock) return false;

      const lockedAt = new Date().toISOString();
      this.revision += 1;
      this.locked = true;
      this.lockedAt = lockedAt;
      this.signatures = (this.signatures as SignRecord[]).map((signature) => ({ ...signature, revision: this.revision }));
      this.decisionLog = this.decisionLog.map((entry) => entry.status === 'valid'
        ? { ...entry, revision: this.revision }
        : entry
      );

      const release: PublishedVersion = {
        revision: this.revision,
        lockedAt,
        steps: clone(this.steps),
        comments: clone(this.comments),
        signatures: clone(this.signatures as SignRecord[]),
        decisionLog: clone(this.decisionLog)
      };
      this.publishedVersions.unshift(release);

      graphqlClient.writeQuery({
        query: LIFT_PLAN_QUERY,
        variables: { id: 'LP-2026-0918' },
        data: {
          liftPlan: {
            __typename: 'LiftPlan',
            id: 'LP-2026-0918',
            name: '东塔转换桁架吊装',
            revision: this.revision,
            status: 'LOCKED',
            steps: release.steps.map((step) => ({
              __typename: 'LiftStep',
              id: step.id,
              name: step.title,
              loadRate: step.loadRate,
              clearance: step.clearance
            })),
            release: {
              __typename: 'PlanRelease',
              revision: release.revision,
              lockedAt: release.lockedAt,
              signatures: release.signatures.map((signature) => ({
                __typename: 'ReleaseSignature',
                personName: signature.personName,
                decision: signature.decision,
                reservation: signature.reservation ?? '',
                signedAt: signature.signedAt
              }))
            }
          }
        }
      });
      this.persist();
      return true;
    },
    startNewVersion(): boolean {
      if (!this.locked) return false;
      this.revision += 1;
      this.locked = false;
      this.lockedAt = undefined;
      this.signatures = this.reviewers.map(() => null);
      this.decisionLog = [];
      this.basisHash = buildPlanBasis(this.steps, this.comments);
      this.persist();
      return true;
    },
    setBookmark(name: string) {
      this.activeBookmark = name;
      if (!this.viewBookmarks.includes(name)) this.viewBookmarks.push(name);
      this.persist();
    },
    persist() {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(cacheKey, JSON.stringify({ ...this.$state, draftSavedAt: new Date().toISOString() }));
      }
    }
  }
});
