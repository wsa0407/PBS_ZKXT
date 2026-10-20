import { getDb, json, now, parse, tx } from "./db.mjs";
import * as store from "./collaboration-store.mjs";
import * as inbox from "./conversation-store.mjs";
import { approvalPreview, approveUnderstanding } from "./collaboration-approval.mjs";
import { resolveCard } from "./chat.mjs";
import { parseMentions } from "../shared/mentions.mjs";
import * as repo from "./repo.mjs";

const decode = row => row && ({ ...row, data: parse(row.data, {}) });
export const review = id => decode(getDb().prepare("SELECT * FROM conversation_reviews WHERE id=?").get(id ?? ""));
export const latestReview = projectId => decode(getDb().prepare("SELECT * FROM conversation_reviews WHERE project_id=? AND state='pending' ORDER BY rowid DESC LIMIT 1").get(projectId));
const pendingChanges = projectId => getDb().prepare("SELECT 1 FROM chat_messages WHERE project_id=? AND EXISTS (SELECT 1 FROM json_each(chat_messages.payload,'$.cards') WHERE json_extract(value,'$.kind')='agent_change' AND json_extract(value,'$.state')='pending')").get(projectId);
export function offerUnderstanding(t, selection) {
  if (pendingChanges(t.project_id)) return null;
  const preview = approvalPreview(t.project_id);
  if (!preview.requirements.length) return null;
  const requirements = selection?.requirements ?? (selection?.scenarios ? [...new Set(preview.scenarios.filter(s => selection.scenarios.includes(s.code)).flatMap(s => s.links.map(l => l.req_id)))] : preview.requirements.map(r => r.code));
  const scenarios = selection?.scenarios ?? (selection?.requirements ? [] : preview.scenarios.map(s => s.code));
  if (!requirements.length || requirements.some(id => !preview.requirements.some(r => r.code === id)) || scenarios.some(id => !preview.scenarios.some(s => s.code === id))) throw new Error("请使用当前项目真实的需求和场景编号说明确认范围");
  if (preview.scenarios.filter(s => scenarios.includes(s.code)).some(s => s.links.some(l => !requirements.includes(l.req_id)))) throw new Error("拟交接场景的关联需求也需明确列入待审范围");
  const old = latestReview(t.project_id);
  if (old?.kind === "understanding" && old.version === preview.version && (!selection || (json(old.data.requirements) === json(requirements) && json(old.data.scenarios) === json(scenarios)))) return old;
  getDb().prepare("UPDATE conversation_reviews SET state='superseded' WHERE project_id=? AND kind='understanding' AND state='pending'").run(t.project_id);
  const id = store.uid();
  const data = { requirements, scenarios, questions: preview.questions.map(q => ({ id: q.id, question: q.question })) };
  getDb().prepare("INSERT INTO conversation_reviews(id,project_id,task_id,kind,version,data,created_at) VALUES (?,?,?,'understanding',?,?,?)").run(id, t.project_id, t.id, preview.version, json(data), now());
  store.event(t, "approval_required", "understanding", "human", `本轮拟交给 PBS 专家的是 ${requirements.length} 条需求、${scenarios.length} 个场景，详情见右侧。${preview.questions.length ? `还有 ${preview.questions.length} 项待澄清，会继续保留。` : ""}请审阅后直接回复是否确认这个范围，也可以说只确认哪些编号，或告诉我需要修改的地方。`,
    { reviewId: id, approvalRequired: true, reviewScope: data, open: { tab: "understanding" } });
  return review(id);
}
export function offerChange(t, role, event, card, cardIndex = 0) {
  const id = store.uid();
  getDb().prepare("INSERT INTO conversation_reviews(id,project_id,task_id,kind,version,data,created_at) VALUES (?,?,?,'change',?,?,?)")
    .run(id, t.project_id, t.id, card.input_version, json({ messageId: event.chatId, cardIndex, role, text: card.text }), now());
  return review(id);
}
export function ensureChangeReviews(t) {
  const rows = getDb().prepare("SELECT id,payload FROM chat_messages WHERE project_id=? AND EXISTS (SELECT 1 FROM json_each(chat_messages.payload,'$.cards') WHERE json_extract(value,'$.kind')='agent_change' AND json_extract(value,'$.state')='pending') ORDER BY id").all(t.project_id);
  for (const row of rows) {
    const payload = parse(row.payload, {});
    payload.cards.forEach((card, index) => {
      if (card.kind !== "agent_change" || card.state !== "pending" || getDb().prepare("SELECT 1 FROM conversation_reviews WHERE project_id=? AND json_extract(data,'$.messageId')=? AND json_extract(data,'$.cardIndex')=?").get(t.project_id, row.id, index)) return;
      offerChange(t, payload.sender && payload.sender !== "system" ? payload.sender : "understanding", { chatId: row.id }, card, index);
    });
  }
}

// This is an independent conservative guard, not the intent router. The role interprets
// meaning; the host only accepts an unqualified assent tied to the displayed request.
export function explicitReviewReply(text, decision) {
  const value = parseMentions(text).content.trim();
  if (!value || /[?？“”"「」『』]|如果|假如|假设|要是|只有|除非|前提|是否|是不是|能否|能不能|什么|怎么|为什么|多少|[吗么呢]|但是|不过|但|改成|改为|修改|更改|变更|调整|增加|新增|补充|删掉|删除|据说|客户说|原文|标书|等.*(?:后|再)|之后|以后|再确认|再说|例如|比如|还没|没有/.test(value)) return false;
  if (decision === "decline") return /^(?:先|暂时|这次|本轮|我)?(?:不|别|不要|暂不|先不|不同意|不确认|不采纳|取消|拒绝)/.test(value);
  if (/不|别|未|不能|暂缓|取消|拒绝|再看看|考虑|等一下|等等|先等/.test(value)) return false;
  return /确认|同意|采纳|批准|没问题|没意见|可以|好的|好[，。！!\s]*$|开始吧|执行吧|按[此这].*执行|照[此这].*执行|^OK[!！。\s]*$/i.test(value);
}
export function validateReviewReply(m, args) {
  if (!["approve", "decline"].includes(args.review_decision)) throw new Error("请明确记录用户同意还是拒绝，不能省略决定");
  const r = review(args.review_id);
  if (!r || r.project_id !== m.project_id || r.state !== "pending" || m.data.reviewId !== r.id)
    throw new Error("没有关联到发送前展示的有效确认范围，请先说明待确认事项");
  if (!args.quote || args.quote !== parseMentions(m.content).content || !explicitReviewReply(m.content, args.review_decision))
    throw new Error("这条消息不是明确、无条件的确认或拒绝，请回答问题或继续澄清，不要替用户确认");
  if (args.review_decision === "approve" && r.kind === "understanding") {
    const reqs = args.requirements ?? r.data.requirements, scenes = args.scenarios ?? r.data.scenarios;
    if (!reqs.length || reqs.some(id => !r.data.requirements.includes(id)) || scenes.some(id => !r.data.scenarios.includes(id))) throw new Error("不能扩大已展示的确认范围");
    const mentioned = m.content.match(/\b(?:R\d+|SC\d+)\b/gi)?.map(s => s.toUpperCase()) ?? [];
    const selected = [...reqs, ...scenes];
    const partial = json([...reqs].sort()) !== json([...r.data.requirements].sort()) || json([...scenes].sort()) !== json([...r.data.scenarios].sort());
    if (partial && (!mentioned.length || selected.some(id => !mentioned.includes(id)))) throw new Error("部分确认需用户明确说出需求和场景编号，不能由专家自行挑选");
    if (mentioned.length && (mentioned.some(id => !selected.includes(id)) || selected.some(id => !mentioned.includes(id)))) throw new Error("确认范围必须与用户明确给出的编号一致");
  }
  return r;
}
export function applyMessageReview(t, m) {
  const all = inbox.claims(m.id), choices = all.filter(c => c.decision === "review");
  if (!choices.length) return false;
  const choice = choices[0].data, role = choices[0].role;
  try {
    if (all.some(c => c.decision === "claim") || choices.some(c => json({ id: c.data.review_id, decision: c.data.review_decision, requirements: c.data.requirements, scenarios: c.data.scenarios }) !== json({ id: choice.review_id, decision: choice.review_decision, requirements: choice.requirements, scenarios: choice.scenarios })))
      throw new Error("这条回复的范围或意图还不一致，请明确要确认的内容");
    tx(() => {
      const r = validateReviewReply(m, choice);
      if (choice.review_decision === "decline") {
        if (r.kind === "change") resolveCard(t.project_id, r.data.messageId, r.data.cardIndex, "dismiss");
        else {
          store.updateTask(t.id, { stage: "discussion" });
          getDb().prepare("UPDATE collaboration_activations SET state='cancelled' WHERE task_id=? AND role='pbs' AND mode='main' AND state='queued'").run(t.id);
        }
        getDb().prepare("UPDATE conversation_reviews SET state='declined' WHERE id=?").run(r.id);
        store.event(t, "review_result", role, "human", r.kind === "change" ? "好的，这项变更不采纳。你可以直接说新的处理要求。" : "好的，本轮暂不交给 PBS 专家。你可以直接告诉我需要修改的地方。", { reviewId: r.id, userMessageId: m.id });
        return;
      }
      if (store.pendingInputs(t.id).length || inbox.pendingMessages(t.id).some(p => p.id !== m.id)) throw new Error("还有你的新消息尚未处理，我会先核对补充，再请你确认更新后的范围");
      if (r.kind === "understanding") {
        if (pendingChanges(t.project_id)) throw new Error("还有变更建议未处理，请先明确是否采纳，再确认 PBS 范围");
        const confirmed = approveUnderstanding(t.project_id, { version: r.version, requirements: choice.requirements ?? r.data.requirements, scenarios: choice.scenarios ?? r.data.scenarios });
        store.updateTask(t.id, { approval_id: confirmed.id, stage: "pbs" });
        getDb().prepare("UPDATE collaboration_activations SET state='cancelled' WHERE task_id=? AND state='queued'").run(t.id);
        store.enqueue(store.task(t.id), "pbs", "main", { goal: "按用户通过对话确认的范围编制 PBS，必要时向其他专家核对依据" });
        store.event(t, "handoff", "understanding", "pbs", `用户已确认 ${confirmed.snapshot.requirements.length} 条需求、${confirmed.snapshot.scenarios.length} 个场景，请按这个范围编制 PBS。`, { reviewId: r.id, userMessageId: m.id, approvalId: confirmed.id });
      } else {
        const result = resolveCard(t.project_id, r.data.messageId, r.data.cardIndex, "accept");
        store.event(t, "review_result", r.data.role, "human", result.note, { reviewId: r.id, userMessageId: m.id });
      }
      getDb().prepare("UPDATE conversation_reviews SET state='accepted' WHERE id=?").run(r.id);
    });
  } catch (error) {
    store.event(t, "review_question", role, "human", error.message, { reviewId: choice.review_id });
    // A changed range is shown again; a fresh message must approve that new snapshot.
    const r = review(choice.review_id);
    if (r?.kind === "understanding" && r.version !== approvalPreview(t.project_id).version) offerUnderstanding(t);
    if (r?.kind === "change" && /业务内容已变化/.test(error.message)) {
      const msg = repo.getChat(t.project_id, r.data.messageId), card = msg.payload.cards[r.data.cardIndex];
      card.state = "superseded"; card.note = "内容已变化，这项旧建议不再适用，请按当前成果重新说明修改要求。";
      repo.updateChatPayload(t.project_id, msg.id, msg.payload);
      getDb().prepare("UPDATE conversation_reviews SET state='superseded' WHERE id=?").run(r.id);
    }
  }
  return true;
}
