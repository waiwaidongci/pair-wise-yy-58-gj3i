import { defineStore } from 'pinia';
import { graphqlClient, LIFT_PLAN_QUERY } from './graphql';

export type StepStatus = 'pending' | 'passed' | 'blocked';
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

export type Signer = {
  id: string;
  name: string;
  team: string;
  scope: string;
};

export type SignoffDecision = 'accepted' | 'reserved';
export type SignoffInvalidReason = 'step_parameters' | 'control_notes' | 'conflict_status' | 'version_created';

export type SignoffRecord = {
  id: string;
  personId: string;
  personName: string;
  team: string;
  scope: string;
  decision: SignoffDecision;
  reservation?: string;
  signedAt: string;
  basisRevision: number;
  invalidatedAt?: string;
  invalidatedReasons?: SignoffInvalidReason[];
  supersededAt?: string;
};

export type PublishedVersion = {
  revision: number;
  publishedAt: string;
  basedOnRevision: number | null;
  steps: LiftStep[];
  comments: Comment[];
  signoffs: SignoffRecord[];
  records: SignoffRecord[];
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

const SIGNERS: Signer[] = [
  { id: 'general', name: '陈晓', team: '总包项目部', scope: '吊装工序与场地移交' },
  { id: 'equipment', name: '刘明', team: '设备管理', scope: '吊车参数与支腿地基' },
  { id: 'safety', name: '周工', team: '安全监督', scope: '净空、风速与警戒区' },
  { id: 'engineering', name: '赵磊', team: '方案工程', scope: '载荷计算与路径参数' }
];

const STEP_PARAMETER_FIELDS = ['loadRate', 'clearance', 'wind', 'radius', 'boom'] as const;
const cacheKey = 'yy58-lift-plan-draft';
const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(cacheKey) : null;
const saved = stored ? JSON.parse(stored) : null;

function nowIso() {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stepBasis(step: LiftStep) {
  return {
    parameters: STEP_PARAMETER_FIELDS.reduce((result, field) => {
      result[field] = step[field];
      return result;
    }, {} as Record<(typeof STEP_PARAMETER_FIELDS)[number], number>),
    status: step.status,
    note: step.note
  };
}

function buildSignoffBasis(steps: LiftStep[]) {
  return JSON.stringify(steps.map((step) => ({ id: step.id, ...stepBasis(step) })));
}

const initialRevision = typeof saved?.revision === 'number' ? saved.revision : 4;
const initialWorkingRevision = typeof saved?.workingRevision === 'number'
  ? saved.workingRevision
  : saved?.locked
    ? initialRevision
    : initialRevision + 1;

const initialPublishedVersions: PublishedVersion[] = saved?.publishedVersions
  ?? (saved?.locked
    ? [{
      revision: initialWorkingRevision,
      publishedAt: typeof saved.draftSavedAt === 'string' ? saved.draftSavedAt : nowIso(),
      basedOnRevision: null,
      steps: clone(saved.steps as LiftStep[]),
      comments: clone(saved.comments as Comment[]),
      signoffs: [],
      records: []
    }]
    : []);

export const useLiftStore = defineStore('lift-plan', {
  state: () => ({
    steps: (saved?.steps as LiftStep[]) ?? clone(initialSteps),
    comments: (saved?.comments as Comment[]) ?? clone(initialComments),
    signers: clone(SIGNERS),
    signoffs: (saved?.signoffs as SignoffRecord[]) ?? [],
    signoffHistory: (saved?.signoffHistory as SignoffRecord[]) ?? [],
    publishedVersions: initialPublishedVersions,
    selectedStepId: (saved?.selectedStepId as string) ?? 'S-02',
    revision: initialRevision,
    workingRevision: initialWorkingRevision,
    basedOnRevision: (saved?.basedOnRevision as number | null | undefined) ?? initialRevision,
    locked: (saved?.locked as boolean) ?? false,
    signoffBasis: (saved?.signoffBasis as string | undefined) ?? buildSignoffBasis((saved?.steps as LiftStep[] | undefined) ?? initialSteps),
    viewBookmarks: (saved?.viewBookmarks as string[]) ?? ['主吊全景', '东侧障碍', '安装轴线'],
    activeBookmark: (saved?.activeBookmark as string) ?? '主吊全景'
  }),
  getters: {
    selectedStep(state): LiftStep {
      return state.steps.find((step) => step.id === state.selectedStepId) ?? state.steps[0];
    },
    conflicts(state) {
      return state.steps.flatMap((step) => {
        const issues: string[] = [];
        if (step.loadRate > 90) issues.push(`荷载率 ${step.loadRate}% 超过 90% 阈值`);
        if (step.clearance < 1.5) issues.push(`净空 ${step.clearance}m 小于 1.5m`);
        if (step.wind > 8) issues.push(`风速 ${step.wind}m/s 超过暂停值`);
        if (step.radius > step.boom * 0.62) issues.push('工作半径接近额定幅度');
        return issues.map((message, index) => ({ id: `${step.id}-${index}`, stepId: step.id, title: step.title, message, severity: step.status === 'blocked' ? 'high' : 'medium' }));
      });
    },
    openComments(state) {
      return state.comments.filter((comment) => comment.status === 'open');
    },
    acceptedSignoffs(state): SignoffRecord[] {
      return state.signoffs.filter((record) => record.decision === 'accepted');
    },
    activeReservations(state): SignoffRecord[] {
      return state.signoffs.filter((record) => record.decision === 'reserved');
    },
    allSignersAccepted(): boolean {
      return this.acceptedSignoffs.length === this.signers.length;
    },
    invalidatedCurrentRevisionRecords(state): SignoffRecord[] {
      return state.signoffHistory.filter((record) => record.basisRevision === state.workingRevision && record.invalidatedAt);
    },
    lockBlockers(): string[] {
      const blockers: string[] = [];
      if (this.locked) blockers.push('当前版本已锁定发布');
      if (this.conflicts.length > 0) blockers.push(`尚有 ${this.conflicts.length} 项规则冲突未清零`);
      if (this.openComments.length > 0) blockers.push(`尚有 ${this.openComments.length} 条条件意见未关闭`);
      const missingSigners = this.signers.filter((signer) => !this.signoffByPerson(signer.id) || this.signoffByPerson(signer.id)?.decision !== 'accepted');
      if (missingSigners.length > 0) blockers.push(`${missingSigners.map((signer) => signer.name).join('、')} 尚未接受`);
      if (this.activeReservations.length > 0) blockers.push(`${this.activeReservations.map((record) => record.personName).join('、')} 仍有保留意见`);
      return blockers;
    },
    canLock(): boolean {
      return this.lockBlockers.length === 0;
    },
    readiness(): number {
      let score = 100;
      score -= this.conflicts.length * 8;
      score -= this.openComments.length * 8;
      score -= (this.signers.length - this.acceptedSignoffs.length) * 10;
      score -= this.activeReservations.length * 5;
      return Math.max(0, Math.min(100, score));
    },
    signoffByPerson(state) {
      return (personId: string) => state.signoffs.find((record) => record.personId === personId);
    },
    latestHistoryByPerson(state) {
      return (personId: string, revision = state.workingRevision) =>
        state.signoffHistory.find((record) => record.personId === personId && record.basisRevision === revision);
    }
  },
  actions: {
    selectStep(id: string) {
      this.selectedStepId = id;
      this.persist();
    },
    updateStep(patch: Partial<LiftStep>) {
      if (this.locked) return;
      const index = this.steps.findIndex((step) => step.id === this.selectedStepId);
      if (index < 0) return;

      const previous = this.steps[index];
      const next = { ...previous, ...patch };
      const reasons: SignoffInvalidReason[] = [];
      if (STEP_PARAMETER_FIELDS.some((field) => previous[field] !== next[field])) reasons.push('step_parameters');
      if (previous.note !== next.note) reasons.push('control_notes');
      if (previous.status !== next.status) reasons.push('conflict_status');

      if (reasons.length === 0) return;
      this.steps[index] = next;
      this.invalidateSignoffs(reasons);
      this.persist();
    },
    setStatus(status: StepStatus) {
      this.updateStep({ status });
    },
    addComment(content: string, author = '王工', role = '方案') {
      if (this.locked || !content.trim()) return;
      this.comments.unshift({ id: `C-${Date.now()}`, author, role, content, status: 'open', stepId: this.selectedStepId });
      this.persist();
    },
    resolveComment(id: string) {
      if (this.locked) return;
      const item = this.comments.find((comment) => comment.id === id);
      if (item) item.status = 'resolved';
      this.persist();
    },
    submitSignoff(personId: string, decision: SignoffDecision, reservation = '') {
      if (this.locked) return false;
      const signer = this.signers.find((person) => person.id === personId);
      const trimmedReservation = reservation.trim();
      if (!signer || (decision === 'reserved' && !trimmedReservation)) return false;

      const previous = this.signoffs.find((record) => record.personId === personId);
      const record: SignoffRecord = {
        id: `SIG-${Date.now()}-${personId}`,
        personId,
        personName: signer.name,
        team: signer.team,
        scope: signer.scope,
        decision,
        reservation: decision === 'reserved' ? trimmedReservation : undefined,
        signedAt: nowIso(),
        basisRevision: this.workingRevision
      };
      if (previous) {
        this.signoffHistory = [{ ...previous, supersededAt: nowIso() }, ...this.signoffHistory];
      }
      this.signoffs = [...this.signoffs.filter((item) => item.personId !== personId), record];
      this.persist();
      return true;
    },
    invalidateSignoffs(reasons: SignoffInvalidReason[]) {
      if (this.signoffs.length === 0) {
        this.signoffBasis = buildSignoffBasis(this.steps);
        return;
      }
      const at = nowIso();
      const invalidated = this.signoffs.map((record) => ({ ...record, invalidatedAt: at, invalidatedReasons: reasons }));
      this.signoffHistory = [...invalidated, ...this.signoffHistory];
      this.signoffs = [];
      this.signoffBasis = buildSignoffBasis(this.steps);
    },
    lockPlan() {
      if (!this.canLock) return false;

      const at = nowIso();
      const accepted = this.acceptedSignoffs;
      const records = [
        ...this.signoffHistory.filter((record) => record.basisRevision === this.workingRevision),
        ...this.signoffs
      ].sort((a, b) => a.signedAt.localeCompare(b.signedAt));
      const version: PublishedVersion = {
        revision: this.workingRevision,
        publishedAt: at,
        basedOnRevision: this.basedOnRevision,
        steps: clone(this.steps),
        comments: clone(this.comments),
        signoffs: clone(accepted),
        records: clone(records)
      };

      this.publishedVersions = [version, ...this.publishedVersions];
      this.revision = this.workingRevision;
      this.locked = true;
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
            steps: this.steps.map((step) => ({
              __typename: 'LiftStep',
              id: step.id,
              name: step.title,
              loadRate: step.loadRate,
              clearance: step.clearance
            })),
            signoffs: accepted.map((record) => ({
              __typename: 'LiftPlanSignoff',
              id: record.id,
              personName: record.personName,
              decision: record.decision,
              reservation: record.reservation ?? null,
              signedAt: record.signedAt
            }))
          }
        }
      });
      this.persist();
      return true;
    },
    createRevisionFromLocked() {
      if (!this.locked) return false;
      const publishedRevision = this.workingRevision;
      this.invalidateSignoffs(['version_created']);
      this.revision = publishedRevision;
      this.workingRevision = publishedRevision + 1;
      this.basedOnRevision = publishedRevision;
      this.locked = false;
      this.steps = clone(this.steps);
      this.comments = clone(this.comments);
      this.signoffBasis = buildSignoffBasis(this.steps);
      this.persist();
      return true;
    },
    setBookmark(name: string) {
      this.activeBookmark = name;
      if (!this.viewBookmarks.includes(name)) this.viewBookmarks.push(name);
      this.persist();
    },
    persist() {
      if (typeof localStorage !== 'undefined') localStorage.setItem(cacheKey, JSON.stringify({ ...this.$state, draftSavedAt: new Date().toISOString() }));
    }
  }
});
