<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import * as THREE from 'three';
import { useLiftStore, type DecisionLogEntry, type Reviewer, type SignRecord, type StepStatus } from './store';

const route = useRoute();
const router = useRouter();
const store = useLiftStore();
const canvasRef = ref<HTMLCanvasElement | null>(null);
const commentText = ref('');
const sceneContainer = ref<HTMLElement | null>(null);
const selectedArchiveRevision = ref<number | null>(null);
const stepDraft = reactive({
  loadRate: 0,
  clearance: 0,
  wind: 0,
  radius: 0,
  status: 'pending' as StepStatus,
  note: ''
});
const reservationDrafts = reactive<Record<string, string>>({});
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

function syncStepDraft() {
  const step = store.selectedStep;
  stepDraft.loadRate = step.loadRate;
  stepDraft.clearance = step.clearance;
  stepDraft.wind = step.wind;
  stepDraft.radius = step.radius;
  stepDraft.status = step.status;
  stepDraft.note = step.note;
}

function numberValue(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}

function saveStep() {
  store.updateStep({
    loadRate: numberValue(stepDraft.loadRate, store.selectedStep.loadRate),
    clearance: numberValue(stepDraft.clearance, store.selectedStep.clearance),
    wind: numberValue(stepDraft.wind, store.selectedStep.wind),
    radius: numberValue(stepDraft.radius, store.selectedStep.radius),
    status: stepDraft.status,
    note: stepDraft.note
  });
  syncStepDraft();
}

function submitComment() {
  if (store.addComment(commentText.value)) commentText.value = '';
}

function selectStep(id: string) {
  store.selectStep(id);
  syncStepDraft();
}

function currentSignature(person: Reviewer): SignRecord | null {
  return store.signatures[store.reviewers.findIndex((reviewer) => reviewer.id === person.id)] ?? null;
}

function latestDecision(person: Reviewer): DecisionLogEntry | null {
  return store.decisionLog.find((entry) => entry.personId === person.id) ?? null;
}

function signState(signature: SignRecord | null) {
  if (!signature) return '待确认';
  if (signature.basisHash !== store.basisHash || signature.revision !== store.revision) return '已失效';
  return signature.decision === 'accepted' ? '已接受' : '有保留';
}

function signStateColor(state: string) {
  if (state === '已接受') return 'positive';
  if (state === '有保留' || state === '已失效') return 'warning';
  return 'grey';
}

function acceptPlan(person: Reviewer) {
  store.submitSignature(person.id, 'accepted');
}

function submitReservation(person: Reviewer) {
  if (store.submitSignature(person.id, 'reserved', reservationDrafts[person.id] ?? '')) {
    reservationDrafts[person.id] = '';
  }
}

function formatTime(value?: string) {
  return value ? new Date(value).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'medium' }) : '—';
}

const selectedArchive = computed(() => {
  const revision = selectedArchiveRevision.value ?? store.publishedVersions[0]?.revision;
  return store.publishedVersions.find((version) => version.revision === revision) ?? store.publishedVersions[0] ?? null;
});

const archiveSteps = computed(() => selectedArchive.value?.steps ?? []);
const archiveComments = computed(() => selectedArchive.value?.comments ?? []);
const archiveSignatures = computed(() => selectedArchive.value?.signatures ?? []);
const archiveDecisionLog = computed(() => selectedArchive.value?.decisionLog ?? []);

watch(() => store.selectedStepId, syncStepDraft);
watch(() => store.publishedVersions[0]?.revision, (revision) => {
  if (revision && selectedArchiveRevision.value === null) selectedArchiveRevision.value = revision;
}, { immediate: true });
syncStepDraft();

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
          <span>东塔转换桁架 · 方案版本 V{{ store.revision }}</span>
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
              color="primary"
              no-caps
              :icon="'lock'"
              :label="store.locked ? `已发布 V${store.revision} · 发起新版本` : '确认并锁定'"
              @click="store.locked ? store.startNewVersion() : store.lockPlan()"
            />
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
                @click="selectStep(step.id)"
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
                <h2>{{ store.selectedStep.id }} · {{ store.selectedStep.title }}</h2>
              </div>
            </div>
            <div class="metric-grid">
              <div><span>荷载率</span><strong :class="{ danger: stepDraft.loadRate > 90 }">{{ stepDraft.loadRate }}%</strong></div>
              <div><span>最小净空</span><strong :class="{ danger: stepDraft.clearance < 1.5 }">{{ stepDraft.clearance }}m</strong></div>
              <div><span>作业半径</span><strong>{{ stepDraft.radius }}m</strong></div>
              <div><span>风速限制</span><strong>{{ stepDraft.wind }}m/s</strong></div>
            </div>
            <label class="field-label">荷载率</label>
            <q-slider v-model="stepDraft.loadRate" :min="0" :max="120" color="primary" :disable="store.locked" />
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
            <q-btn
              class="save-step"
              color="primary"
              no-caps
              icon="save"
              :label="store.locked ? '版本已锁定，需发起新版本' : '保存步骤修改'"
              :disable="store.locked"
              @click="saveStep"
            />
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
              <button v-for="item in store.conflicts" :key="item.id" class="conflict-item" @click="selectStep(item.stepId)">
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
                  <span v-else class="resolved">{{ store.locked && comment.status === 'open' ? '已随版本冻结' : '已解决' }}</span>
                </div>
              </div>
              <q-input v-model="commentText" type="textarea" outlined autogrow label="对该步骤提出条件或补充意见" :disable="store.locked" />
              <q-btn color="primary" no-caps icon="send" label="提交意见" :disable="store.locked" @click="submitComment" />
            </div>
          </div>
        </section>

        <section v-if="route.path === '/review'" class="content-panel full-panel review-panel">
          <div class="panel-heading">
            <div>
              <span class="panel-kicker">MULTI-PARTY SIGN-OFF</span>
              <h2>多角色会签与发布门禁 · V{{ store.revision }}{{ store.locked ? '（已发布）' : '（会签稿）' }}</h2>
            </div>
            <div class="readiness"><strong>{{ store.readiness }}%</strong><span>发布就绪度</span></div>
          </div>

          <q-banner v-if="store.locked" class="lock-banner" dense rounded>
            <template #avatar><q-icon name="lock_clock" color="teal" /></template>
            V{{ store.revision }} 已锁定发布，当前步骤、控制说明、冲突处理和签字均为只读；后续修改需发起 V{{ store.revision + 1 }} 并重新完成四人会签。
          </q-banner>

          <div class="review-grid">
            <article v-for="person in store.reviewers" :key="person.id" class="review-card">
              <div class="review-head">
                <strong>{{ person.name }}</strong>
                <q-badge :color="signStateColor(signState(currentSignature(person)))">{{ signState(currentSignature(person)) }}</q-badge>
              </div>
              <span>{{ person.team }} · {{ person.role }}</span>
              <p>{{ person.scope }}</p>

              <template v-if="currentSignature(person)">
                <div class="signature-meta">
                  <strong>{{ currentSignature(person)?.decision === 'accepted' ? '接受方案' : '保留意见' }}</strong>
                  <small>{{ formatTime(currentSignature(person)?.signedAt) }}</small>
                </div>
                <p v-if="currentSignature(person)?.reservation" class="reservation-text">{{ currentSignature(person)?.reservation }}</p>
              </template>
              <div v-else class="signature-meta empty">尚未对 V{{ store.revision }} 会签稿确认。</div>
              <div
                v-if="!store.locked && !currentSignature(person) && latestDecision(person)?.status === 'invalidated'"
                class="signature-warning"
              >
                <q-icon name="warning" />
                <span>{{ latestDecision(person)?.invalidReason }}，此前签字已于 {{ formatTime(latestDecision(person)?.invalidatedAt) }} 失效。</span>
              </div>

              <template v-if="!store.locked">
                <q-input
                  v-model="reservationDrafts[person.id]"
                  type="textarea"
                  autogrow
                  outlined
                  dense
                  label="保留意见（填写后提交）"
                  class="reservation-input"
                />
                <div class="review-actions">
                  <q-btn unelevated color="positive" no-caps icon="check_circle" label="接受" @click="acceptPlan(person)" />
                  <q-btn
                    outline
                    color="warning"
                    no-caps
                    icon="rate_review"
                    label="提交保留"
                    :disable="!(reservationDrafts[person.id] ?? '').trim()"
                    @click="submitReservation(person)"
                  />
                </div>
                <small class="signature-rule">修改步骤参数、控制说明或冲突处理后，四人需按当前方案重新确认。</small>
              </template>
            </article>
          </div>

          <div class="release-gate">
            <div>
              <q-icon name="verified_user" size="30px" />
              <div>
                <strong>发布前门禁</strong>
                <ul class="gate-list">
                  <li :class="{ done: store.conflicts.length === 0 }">规则冲突清零（{{ store.conflicts.length }} 项未清）</li>
                  <li :class="{ done: store.openComments.length === 0 }">冲突处理意见全部关闭（{{ store.openComments.length }} 项遗留）</li>
                  <li :class="{ done: store.acceptedSignatures.length === store.reviewers.length }">四个角色均接受（{{ store.acceptedSignatures.length }}/{{ store.reviewers.length }}）</li>
                  <li :class="{ done: store.reservedSignatures.length === 0 }">无保留意见（{{ store.reservedSignatures.length }} 项待处理）</li>
                </ul>
              </div>
            </div>
            <q-btn
              v-if="!store.locked"
              color="primary"
              no-caps
              icon="lock"
              label="锁定并发布"
              :disable="!store.canLock"
              @click="store.lockPlan"
            />
            <q-btn v-else color="secondary" no-caps icon="post_add" :label="`发起 V${store.revision + 1} 重新会签`" @click="store.startNewVersion" />
          </div>

          <div class="history-panel">
            <div class="history-heading">
              <div>
                <span class="panel-kicker">VERSION ARCHIVE</span>
                <h3>已发布版本与历史会签</h3>
              </div>
              <q-select
                v-model="selectedArchiveRevision"
                :options="store.publishedVersions.map(version => ({ label: `V${version.revision} · ${formatTime(version.lockedAt)}`, value: version.revision }))"
                outlined
                dense
                emit-value
                map-options
                label="查询旧版本"
                :disable="store.publishedVersions.length === 0"
              />
            </div>

            <div v-if="selectedArchive" class="history-grid">
              <div class="history-section">
                <h4>发布签字</h4>
                <div v-for="person in store.reviewers" :key="person.id" class="archive-sign-row">
                  <div>
                    <strong>{{ person.name }}</strong>
                    <small>{{ person.team }}</small>
                  </div>
                  <div>
                    <q-badge color="positive">已接受</q-badge>
                    <small>{{ formatTime(archiveSignatures.find(signature => signature.personId === person.id)?.signedAt) }}</small>
                  </div>
                </div>
                <p class="archive-published-at">发布时间：{{ formatTime(selectedArchive.lockedAt) }}</p>
              </div>

              <div class="history-section">
                <h4>意见与冲突处理（共 {{ archiveComments.length }} 条）</h4>
                <div v-for="comment in archiveComments" :key="comment.id" class="archive-comment">
                  <strong>{{ comment.author }} · {{ comment.stepId }} · <em>{{ comment.status === 'resolved' ? '已解决' : '遗留' }}</em></strong>
                  <p>{{ comment.content }}</p>
                </div>
              </div>

              <div class="history-section">
                <h4>决策留痕（{{ archiveDecisionLog.length }} 条）</h4>
                <div v-for="entry in archiveDecisionLog" :key="entry.id" class="archive-comment">
                  <strong>
                    {{ entry.personName }} ·
                    {{ entry.decision === 'accepted' ? '接受' : '保留' }} ·
                    <em>{{ entry.status === 'valid' ? '已用于发布' : entry.status === 'superseded' ? '被新签字替代' : '因方案变更失效' }}</em>
                  </strong>
                  <p>{{ entry.invalidReason || entry.reservation || '无保留意见' }}</p>
                  <small>
                    {{ formatTime(entry.signedAt) }}
                    <template v-if="entry.supersededAt"> / 替代于 {{ formatTime(entry.supersededAt) }}</template>
                    <template v-if="entry.invalidatedAt"> / 失效于 {{ formatTime(entry.invalidatedAt) }}</template>
                  </small>
                </div>
                <div v-if="archiveDecisionLog.length === 0" class="empty-state">本版本没有会签记录。</div>
              </div>

              <div class="history-section wide">
                <h4>版本步骤快照</h4>
                <div class="archive-step-grid">
                  <div v-for="step in archiveSteps" :key="step.id" class="archive-step">
                    <strong>{{ step.id }} · {{ step.title }}</strong>
                    <span>{{ step.loadRate }}% 荷载 · {{ step.clearance }}m 净空 · {{ step.wind }}m/s</span>
                    <small>{{ step.note }}</small>
                  </div>
                </div>
              </div>
            </div>
            <div v-else class="empty-state archive-empty">暂无已锁定发布版本；四人接受且无遗留意见后，可在此查回发布版本、签字和处理意见。</div>
          </div>
        </section>
      </q-page>
    </q-page-container>
  </q-layout>
</template>
