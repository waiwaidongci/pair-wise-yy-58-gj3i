<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import * as THREE from 'three';
import { useLiftStore, type LiftStep, type PublishedVersion, type Signer, type SignoffInvalidReason, type SignoffRecord } from './store';

const route = useRoute();
const router = useRouter();
const store = useLiftStore();
const canvasRef = ref<HTMLCanvasElement | null>(null);
const commentText = ref('');
const sceneContainer = ref<HTMLElement | null>(null);
const stepDraft = reactive<LiftStep>({ ...store.selectedStep });
const reservationDrafts = reactive<Record<string, string>>(
  Object.fromEntries(store.signers.map((signer) => {
    const current = store.signoffByPerson(signer.id);
    return [signer.id, current?.decision === 'reserved' ? current.reservation ?? '' : ''];
  }))
);
let renderer: THREE.WebGLRenderer | null = null;
let frame = 0;
let resizeObserver: ResizeObserver | null = null;
let theta = 0.8;
let phi = 0.9;
let dragging = false;
let previousX = 0;

const nav = [
  { path: '/', label: '三维复核', icon: 'view_in_ar' },
  { path: '/models', label: '模型与参数', icon: 'tune' },
  { path: '/checks', label: '冲突与评论', icon: 'rule' },
  { path: '/review', label: '多角色会签', icon: 'fact_check' }
];

const pageTitle = computed(() => nav.find((item) => item.path === route.path)?.label ?? '吊装工作台');

function go(path: string) {
  router.push(path);
}

function severityLabel(severity: string) {
  return severity === 'high' ? '阻断' : '预警';
}

function submitComment() {
  store.addComment(commentText.value);
  commentText.value = '';
}

watch(
  () => store.selectedStep,
  (step) => Object.assign(stepDraft, { ...step })
);

function saveStepDraft() {
  const patch: Partial<LiftStep> = {
    status: stepDraft.status,
    note: stepDraft.note
  };
  const numericFields = ['loadRate', 'clearance', 'wind', 'radius', 'boom'] as const;
  numericFields.forEach((field) => {
    const value = Number(stepDraft[field]);
    if (Number.isFinite(value)) patch[field] = value;
  });
  store.updateStep(patch);
}

function formatDateTime(value?: string) {
  if (!value) return '—';
  return new Date(value).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

const invalidReasonLabels: Record<SignoffInvalidReason, string> = {
  step_parameters: '步骤参数',
  control_notes: '控制说明',
  conflict_status: '冲突处理',
  version_created: '新版本创建'
};

function latestSignoff(signer: Signer): SignoffRecord | undefined {
  return store.signoffByPerson(signer.id) ?? store.latestHistoryByPerson(signer.id, store.workingRevision);
}

function signoffState(record?: SignoffRecord) {
  if (!record) return { label: '待确认', color: 'grey' };
  if (record.invalidatedAt) return { label: '签字已失效', color: 'negative' };
  if (record.supersededAt) return { label: '已更新', color: 'grey' };
  return record.decision === 'accepted'
    ? { label: '已接受', color: 'positive' }
    : { label: '有保留', color: 'warning' };
}

function invalidReasons(record?: SignoffRecord) {
  return record?.invalidatedReasons?.map((reason) => invalidReasonLabels[reason]).join('、') ?? '';
}

function acceptPlan(signer: Signer) {
  if (store.submitSignoff(signer.id, 'accepted')) reservationDrafts[signer.id] = '';
}

function reservePlan(signer: Signer) {
  store.submitSignoff(signer.id, 'reserved', reservationDrafts[signer.id]);
}

function recordStateLabel(version: PublishedVersion, record: SignoffRecord) {
  if (version.signoffs.some((item) => item.id === record.id)) return { label: '发布签署', color: 'positive' };
  if (record.invalidatedAt) return { label: '已失效', color: 'negative' };
  if (record.supersededAt) return { label: '已更新', color: 'grey' };
  return record.decision === 'accepted' ? { label: '已接受', color: 'teal' } : { label: '保留意见', color: 'warning' };
}

function initializeScene() {
  if (!canvasRef.value || !sceneContainer.value) return;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#dce6e1');
  scene.fog = new THREE.Fog('#dce6e1', 34, 78);

  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 160);
  renderer = new THREE.WebGLRenderer({ canvas: canvasRef.value, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  scene.add(new THREE.HemisphereLight('#eefaf5', '#273b34', 2.3));
  const sun = new THREE.DirectionalLight('#fff4d6', 3.2);
  sun.position.set(14, 28, 18);
  scene.add(sun);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 44),
    new THREE.MeshStandardMaterial({ color: '#b8c7bf', roughness: 0.95 })
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const grid = new THREE.GridHelper(60, 30, '#80948a', '#a8b8b0');
  grid.position.y = 0.02;
  scene.add(grid);

  const steel = new THREE.MeshStandardMaterial({ color: '#ec7a3c', roughness: 0.48, metalness: 0.35 });
  const darkSteel = new THREE.MeshStandardMaterial({ color: '#2d5c4f', roughness: 0.58, metalness: 0.42 });
  const truss = new THREE.Group();
  const chordGeometry = new THREE.BoxGeometry(18, 1.1, 1.1);
  for (const z of [-3.5, 3.5]) {
    for (const y of [4.2, 8.4]) {
      const chord = new THREE.Mesh(chordGeometry, steel);
      chord.position.set(0, y, z);
      truss.add(chord);
    }
  }
  for (let x = -8; x <= 8; x += 2) {
    const brace = new THREE.Mesh(new THREE.BoxGeometry(0.34, 4.8, 0.34), steel);
    brace.position.set(x, 6.2, -3.5);
    brace.rotation.z = x % 4 === 0 ? 0.36 : -0.36;
    truss.add(brace);
    const cross = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 7), darkSteel);
    cross.position.set(x, 4.2, 0);
    truss.add(cross);
  }
  truss.position.set(0, 6.5, 2);
  scene.add(truss);

  const crane = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(7, 1.2, 5), darkSteel);
  base.position.y = 0.6;
  crane.add(base);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(3, 2.7, 3), new THREE.MeshStandardMaterial({ color: '#d8a733' }));
  cabin.position.set(-1, 2.5, 0);
  crane.add(cabin);
  const mast = new THREE.Mesh(new THREE.BoxGeometry(1.2, 24, 1.2), darkSteel);
  mast.position.y = 12;
  crane.add(mast);
  const boom = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 36), steel);
  boom.position.set(-8.5, 20.5, 9.5);
  boom.rotation.set(-0.38, 0.7, 0.14);
  crane.add(boom);
  crane.position.set(-15, 0, -12);
  scene.add(crane);

  const obstacleMat = new THREE.MeshStandardMaterial({ color: '#d34c45', transparent: true, opacity: 0.38 });
  const obstacle = new THREE.Mesh(new THREE.BoxGeometry(5, 5, 4), obstacleMat);
  obstacle.position.set(10, 2.5, 8);
  scene.add(obstacle);
  scene.add(new THREE.BoxHelper(obstacle, '#a92d2a'));

  const updateCamera = () => {
    const radius = 48;
    camera.position.set(
      Math.sin(theta) * Math.sin(phi) * radius,
      Math.cos(phi) * radius + 12,
      Math.cos(theta) * Math.sin(phi) * radius
    );
    camera.lookAt(0, 7, 0);
  };

  const render = () => {
    frame = requestAnimationFrame(render);
    truss.position.y = 6.5 + Math.sin(Date.now() / 900) * 0.08;
    updateCamera();
    renderer?.render(scene, camera);
  };
  render();

  const resize = () => {
    if (!sceneContainer.value || !renderer) return;
    const { width, height } = sceneContainer.value.getBoundingClientRect();
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(height, 1);
    camera.updateProjectionMatrix();
  };
  resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(sceneContainer.value);
  resize();

  canvasRef.value.onpointerdown = (event) => {
    dragging = true;
    previousX = event.clientX;
    canvasRef.value?.setPointerCapture(event.pointerId);
  };
  canvasRef.value.onpointermove = (event) => {
    if (!dragging) return;
    theta += (event.clientX - previousX) * 0.006;
    previousX = event.clientX;
  };
  canvasRef.value.onpointerup = () => {
    dragging = false;
  };
}

onMounted(() => {
  nextTick(initializeScene);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(frame);
  resizeObserver?.disconnect();
  renderer?.dispose();
});
</script>

<template>
  <q-layout view="hHh Lpr lFf" class="app-shell">
    <q-header elevated class="topbar">
      <q-toolbar>
        <div class="brand-mark">LIFT</div>
        <div class="brand-copy">
          <strong>大型构件吊装三维校核</strong>
          <span>东塔转换桁架 · {{ store.locked ? '已发布版本' : '待发布版本' }} V{{ store.workingRevision }}</span>
        </div>
        <q-space />
        <q-badge :color="store.locked ? 'teal' : 'orange'" outline class="status-badge">
          {{ store.locked ? '已锁定发布' : '会签中' }}
        </q-badge>
        <q-btn dense flat round icon="notifications" aria-label="通知">
          <q-badge floating color="red">{{ store.openComments.length }}</q-badge>
        </q-btn>
      </q-toolbar>
    </q-header>

    <q-drawer show-if-above side="left" :width="232" bordered class="left-nav">
      <div class="drawer-section-label">方案工作区</div>
      <q-list padding>
        <q-item
          v-for="item in nav"
          :key="item.path"
          clickable
          :active="route.path === item.path"
          active-class="nav-active"
          @click="go(item.path)"
        >
          <q-item-section avatar><q-icon :name="item.icon" /></q-item-section>
          <q-item-section>{{ item.label }}</q-item-section>
          <q-item-section v-if="item.path === '/checks'" side>
            <q-badge color="negative">{{ store.conflicts.length }}</q-badge>
          </q-item-section>
        </q-item>
      </q-list>
      <div class="draft-state">
        <q-icon name="cloud_done" color="teal" />
        <span>草稿已自动保存<br /><small>{{ new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }}</small></span>
      </div>
    </q-drawer>

    <q-page-container>
      <q-page class="workspace-page">
        <header class="page-heading">
          <div>
            <div class="eyebrow">LP-2026-0918 / {{ pageTitle }}</div>
            <h1>{{ pageTitle }}</h1>
          </div>
          <div class="heading-actions">
            <q-btn outline no-caps icon="ios_share" label="导出吊装指令" />
            <q-btn
              v-if="store.locked"
              color="primary"
              outline
              no-caps
              icon="post_add"
              label="基于 V{{ store.workingRevision }} 新建修订版"
              @click="store.createRevisionFromLocked"
            />
            <q-btn
              v-else
              color="primary"
              no-caps
              icon="lock"
              :label="`锁定并发布 V${store.workingRevision}`"
              :disable="!store.canLock"
              @click="store.lockPlan"
            >
              <q-tooltip v-if="store.lockBlockers.length">{{ store.lockBlockers.join('；') }}</q-tooltip>
            </q-btn>
          </div>
        </header>

        <section v-if="route.path === '/' || route.path === '/models'" class="work-grid">
          <article class="scene-panel content-panel">
            <div class="panel-heading">
              <div>
                <span class="panel-kicker">THREE.JS SCENE</span>
                <h2>吊装姿态与空间冲突</h2>
              </div>
              <div class="view-bookmarks">
                <button
                  v-for="bookmark in store.viewBookmarks"
                  :key="bookmark"
                  :class="{ active: store.activeBookmark === bookmark }"
                  @click="store.setBookmark(bookmark)"
                >
                  {{ bookmark }}
                </button>
              </div>
            </div>
            <div ref="sceneContainer" class="scene-container">
              <canvas ref="canvasRef" aria-label="吊装三维场景" />
              <div class="scene-legend">
                <span><i class="legend-dot crane" />主吊</span>
                <span><i class="legend-dot load" />构件</span>
                <span><i class="legend-dot risk" />障碍物</span>
              </div>
              <div class="scene-hint">拖动旋转视角 · 滚轮缩放由设备手势控制</div>
            </div>
            <div class="timeline">
              <button
                v-for="(step, index) in store.steps"
                :key="step.id"
                class="timeline-step"
                :class="[step.status, { selected: store.selectedStepId === step.id }]"
                @click="store.selectStep(step.id)"
              >
                <span>{{ step.time }}</span>
                <strong>{{ step.title }}</strong>
                <small>{{ step.loadRate }}% 荷载 · {{ step.clearance }}m 净空</small>
              </button>
            </div>
          </article>

          <aside class="inspector-panel content-panel">
            <div class="panel-heading compact">
              <div>
                <span class="panel-kicker">STEP INSPECTOR</span>
                <h2>{{ stepDraft.id }} · {{ stepDraft.title }}</h2>
              </div>
            </div>
            <div class="metric-grid">
              <div><span>荷载率</span><strong :class="{ danger: stepDraft.loadRate > 90 }">{{ stepDraft.loadRate }}%</strong></div>
              <div><span>最小净空</span><strong :class="{ danger: stepDraft.clearance < 1.5 }">{{ stepDraft.clearance }}m</strong></div>
              <div><span>作业半径</span><strong>{{ stepDraft.radius }}m</strong></div>
              <div><span>风速限制</span><strong>{{ stepDraft.wind }}m/s</strong></div>
            </div>
            <label class="field-label">荷载率</label>
            <q-slider v-model.number="stepDraft.loadRate" :min="0" :max="120" color="primary" :disable="store.locked" />
            <div class="form-row">
              <q-input v-model.number="stepDraft.clearance" type="number" label="最小净空 / m" outlined dense :disable="store.locked" />
              <q-input v-model.number="stepDraft.wind" type="number" label="风速 / m/s" outlined dense :disable="store.locked" />
            </div>
            <label class="field-label">步骤结论</label>
            <q-btn-toggle
              v-model="stepDraft.status"
              spread
              no-caps
              toggle-color="primary"
              :disable="store.locked"
              :options="[
                { label: '待复核', value: 'pending' },
                { label: '通过', value: 'passed' },
                { label: '阻断', value: 'blocked' }
              ]"
            />
            <q-input v-model="stepDraft.note" type="textarea" autogrow outlined label="现场控制说明" class="note-input" :disable="store.locked" />
            <q-btn class="save-step" color="primary" no-caps icon="save" label="保存步骤修改" :disable="store.locked" @click="saveStepDraft" />
          </aside>
        </section>

        <section v-if="route.path === '/checks'" class="content-panel full-panel">
          <div class="panel-heading">
            <div>
              <span class="panel-kicker">RULE ENGINE</span>
              <h2>冲突定位与条件清单</h2>
            </div>
            <q-badge color="negative">{{ store.conflicts.length }} 项待处理</q-badge>
          </div>
          <div class="check-layout">
            <div class="conflict-list">
              <button v-for="item in store.conflicts" :key="item.id" class="conflict-item" @click="store.selectStep(item.stepId)">
                <span class="severity" :class="item.severity">{{ severityLabel(item.severity) }}</span>
                <div><strong>{{ item.stepId }} · {{ item.title }}</strong><small>{{ item.message }}</small></div>
                <q-icon name="arrow_forward" />
              </button>
              <div v-if="store.conflicts.length === 0" class="empty-state">当前版本未发现规则冲突。</div>
            </div>
            <div class="comments-panel">
              <h3>条件与评论 · {{ store.selectedStep.id }}</h3>
              <div v-for="comment in store.comments.filter(c => c.stepId === store.selectedStepId)" :key="comment.id" class="comment-row">
                <div class="comment-avatar">{{ comment.author.slice(0, 1) }}</div>
                <div>
                  <strong>{{ comment.author }} <small>{{ comment.role }}</small></strong>
                  <p>{{ comment.content }}</p>
                  <button v-if="comment.status === 'open' && !store.locked" @click="store.resolveComment(comment.id)">标记已解决</button>
                  <span v-else-if="comment.status === 'open'" class="resolved">版本已锁定</span>
                  <span v-else class="resolved">已解决</span>
                </div>
              </div>
              <q-input v-model="commentText" type="textarea" outlined autogrow label="对该步骤提出条件或补充意见" :disable="store.locked" />
              <q-btn color="primary" no-caps icon="send" label="提交意见" :disable="store.locked || !commentText.trim()" @click="submitComment" />
            </div>
          </div>
        </section>

        <section v-if="route.path === '/review'" class="content-panel full-panel">
          <div class="panel-heading">
            <div>
              <span class="panel-kicker">MULTI-PARTY SIGN-OFF</span>
              <h2>多角色会签与发布门禁</h2>
            </div>
            <div class="readiness"><strong>{{ store.readiness }}%</strong><span>发布就绪度</span></div>
          </div>

          <div v-if="store.locked" class="signoff-banner locked">
            <q-icon name="verified" size="22px" />
            <div>
              <strong>V{{ store.workingRevision }} 已锁定发布</strong>
              <span>锁定时记录了发布版本、步骤快照、四人签字和全部意见。之后修改需新建 V{{ store.workingRevision + 1 }} 并重新会签。</span>
            </div>
          </div>
          <div v-else-if="store.invalidatedCurrentRevisionRecords.length > 0" class="signoff-banner invalid">
            <q-icon name="gpp_bad" size="22px" />
            <div>
              <strong>V{{ store.workingRevision }} 存在已失效签字</strong>
              <span>步骤参数、现场控制说明或冲突处理保存后，原签字立即失效；相关人员必须重新接受后方可发布。</span>
            </div>
          </div>

          <div class="review-grid">
            <article v-for="person in store.signers" :key="person.id" class="review-card">
              <template v-for="record in [latestSignoff(person)]" :key="person.id">
                <div class="review-head">
                  <strong>{{ person.name }}</strong>
                  <q-badge :color="signoffState(record).color">{{ signoffState(record).label }}</q-badge>
                </div>
                <span>{{ person.team }}</span>
                <p>{{ person.scope }}</p>

                <div v-if="record && !record.invalidatedAt" class="signoff-record valid">
                  <template v-if="record.decision === 'accepted'">
                    <strong><q-icon name="check_circle" color="positive" /> 已接受方案</strong>
                    <small>签字时间：{{ formatDateTime(record.signedAt) }}</small>
                  </template>
                  <template v-else>
                    <strong><q-icon name="error" color="warning" /> 保留意见</strong>
                    <p>{{ record.reservation }}</p>
                    <small>提交时间：{{ formatDateTime(record.signedAt) }}</small>
                  </template>
                </div>
                <div v-else-if="record" class="signoff-record invalid-record">
                  <strong>原签字已失效：{{ invalidReasons(record) }}已改动</strong>
                  <small>失效时间：{{ formatDateTime(record.invalidatedAt) }}，请重新确认。</small>
                </div>
                <div v-else class="signoff-record pending-record">
                  <small>尚未对 V{{ store.workingRevision }} 作出确认。</small>
                </div>

                <q-input
                  v-model="reservationDrafts[person.id]"
                  type="textarea"
                  autogrow
                  outlined
                  dense
                  class="reservation-input"
                  label="保留意见（不接受时必填）"
                  :disable="store.locked || (record?.decision === 'reserved' && !record.invalidatedAt && reservationDrafts[person.id].trim() === record.reservation)"
                />
                <div class="review-actions">
                  <q-btn
                    color="positive"
                    no-caps
                    icon="task_alt"
                    label="接受"
                    :disable="store.locked || (record?.decision === 'accepted' && !record.invalidatedAt)"
                    @click="acceptPlan(person)"
                  />
                  <q-btn
                    outline
                    color="warning"
                    no-caps
                    icon="rate_review"
                    label="提交保留"
                    :disable="store.locked || !reservationDrafts[person.id].trim() || (record?.decision === 'reserved' && !record.invalidatedAt && reservationDrafts[person.id].trim() === record.reservation)"
                    @click="reservePlan(person)"
                  />
                </div>
              </template>
            </article>
          </div>

          <div class="release-gate">
            <div>
              <q-icon :name="store.canLock ? 'verified_user' : 'lock'" size="30px" />
              <div>
                <strong>发布前门禁</strong>
                <span v-if="store.locked">V{{ store.workingRevision }} 已发布；发布快照含最终四人签字。</span>
                <span v-else-if="store.canLock">四人全部接受且无遗留保留意见，可锁定发布 V{{ store.workingRevision }}。</span>
                <span v-else>{{ store.lockBlockers.join('；') }}</span>
              </div>
            </div>
            <q-btn
              :color="store.canLock ? 'primary' : 'grey-7'"
              no-caps
              icon="lock"
              :label="store.locked ? `V${store.workingRevision} 已锁定` : `锁定并发布 V${store.workingRevision}`"
              :disable="store.locked || !store.canLock"
              @click="store.lockPlan"
            />
          </div>

          <div class="history-panel">
            <div class="history-heading">
              <h3>历史发布版本会签</h3>
              <q-badge outline color="teal">{{ store.publishedVersions.length }} 个版本</q-badge>
            </div>
            <q-list v-if="store.publishedVersions.length" bordered separator>
              <q-expansion-item
                v-for="version in store.publishedVersions"
                :key="version.revision"
                :icon="version.revision === store.workingRevision ? 'lock' : 'history'"
                :label="`V${version.revision} · ${formatDateTime(version.publishedAt)}`"
                :caption="`${version.signoffs.length} 人最终接受 · ${version.comments.length} 条意见快照`"
                header-class="version-header"
              >
                <div class="version-detail">
                  <div class="version-meta">
                    <span>发布时间：{{ formatDateTime(version.publishedAt) }}</span>
                    <span>来源修订：{{ version.basedOnRevision ? `V${version.basedOnRevision} 草稿` : '初次发布' }}</span>
                    <span>步骤快照：{{ version.steps.length }} 步</span>
                  </div>

                  <h4>签字记录</h4>
                  <div v-for="record in version.records" :key="record.id" class="history-record">
                    <div>
                      <strong>{{ record.personName }} · {{ record.team }}</strong>
                      <small>{{ formatDateTime(record.signedAt) }} ｜ {{ record.scope }}</small>
                    </div>
                    <q-badge :color="recordStateLabel(version, record).color">{{ recordStateLabel(version, record).label }}</q-badge>
                    <p v-if="record.reservation">保留意见：{{ record.reservation }}</p>
                    <small v-if="record.invalidatedAt" class="muted">
                      失效于 {{ formatDateTime(record.invalidatedAt) }}（{{ invalidReasons(record) }}）
                    </small>
                  </div>

                  <h4>条件与评论</h4>
                  <div v-if="version.comments.length === 0" class="empty-state">该版本没有评论记录。</div>
                  <div v-for="comment in version.comments" :key="comment.id" class="history-comment">
                    <strong>{{ comment.stepId }} · {{ comment.author }}（{{ comment.role }}）</strong>
                    <q-badge dense :color="comment.status === 'resolved' ? 'positive' : 'warning'">
                      {{ comment.status === 'resolved' ? '已关闭' : '未关闭' }}
                    </q-badge>
                    <p>{{ comment.content }}</p>
                  </div>

                  <h4>步骤参数与控制说明</h4>
                  <div class="version-steps">
                    <span v-for="step in version.steps" :key="step.id">
                      {{ step.id }}：荷载 {{ step.loadRate }}%，净空 {{ step.clearance }}m，风速 {{ step.wind }}m/s；{{ step.note }}
                    </span>
                  </div>
                </div>
              </q-expansion-item>
            </q-list>
            <div v-else class="empty-state">尚未锁定发布版本；发布后可在这里查回每一版的签字和意见。</div>
          </div>
        </section>
      </q-page>
    </q-page-container>
  </q-layout>
</template>
