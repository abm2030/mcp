// ============================================================
// workflows/meeting_summary.ts
// سكربت سير عمل: أتمتة محضر الاجتماع
// المؤلف: abm2030 | تاريخ الإنشاء: 2026-03-21
// الهدف: يأخذ بيانات الاجتماع (جدول الأعمال، الحضور، النقاط)
//   ويقوم بـ:
//   1. إنشاء محضر رسمي في Notion
//   2. إنشاء مهام المتابعة في Monday.com
//   3. إرسال ملخص للمشاركين عبر Slack
// ============================================================

import fetch from 'node-fetch';

// ─── إعدادات الاتصال ─────────────────────────────────────────
const WAYSTATION_API = process.env.WAY_BASE || 'https://waystation.ai';
const WAY_KEY        = process.env.WAY_KEY  || '';

if (!WAY_KEY) {
  console.error('[خطأ] متغير WAY_KEY غير مُعيَّن.');
  process.exit(1);
}

// ─── أنواع البيانات ──────────────────────────────────────────
interface ActionItem {
  task       : string;   // وصف المهمة
  assignedTo : string;   // المسؤول عن التنفيذ
  dueDate    : string;   // تاريخ الاستحقاق ISO 8601
  priority   : 'عالية' | 'متوسطة' | 'منخفضة';
}

interface MeetingData {
  meetingId    : string;
  title        : string;       // عنوان الاجتماع
  date         : string;       // تاريخ الاجتماع ISO 8601
  location     : string;       // المكان أو رابط الاجتماع الافتراضي
  chair        : string;       // رئيس الاجتماع
  attendees    : string[];     // قائمة الحاضرين
  agenda       : string[];     // بنود جدول الأعمال
  decisions    : string[];     // القرارات المتخذة
  actionItems  : ActionItem[]; // مهام المتابعة
  notes        : string;       // ملاحظات إضافية
}

// ─── دالة مساعدة: استدعاء أداة WayStation ────────────────────
async function callWayStation(toolName: string, toolInput: Record<string, unknown>) {
  const response = await fetch(`${WAYSTATION_API}/tools/call`, {
    method : 'POST',
    headers: {
      'Content-Type' : 'application/json',
      'Authorization': WAY_KEY,
    },
    body: JSON.stringify({
      params: { name: toolName, input: toolInput },
    }),
  });
  if (!response.ok) {
    throw new Error(`[WayStation] فشل: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

// ─── دالة مساعدة: بناء بلوك نصي لـ Notion ───────────────────
function textBlock(content: string): Record<string, unknown> {
  return {
    object: 'block', type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content } }] },
  };
}

function h2Block(content: string): Record<string, unknown> {
  return {
    object: 'block', type: 'heading_2',
    heading_2: { rich_text: [{ type: 'text', text: { content } }] },
  };
}

function bulletBlock(content: string): Record<string, unknown> {
  return {
    object: 'block', type: 'bulleted_list_item',
    bulleted_list_item: { rich_text: [{ type: 'text', text: { content } }] },
  };
}

// ─── الخطوة 1: إنشاء محضر الاجتماع في Notion ────────────────
async function createMeetingMinutes(meeting: MeetingData): Promise<string> {
  console.log(`[Notion] إنشاء محضر اجتماع: ${meeting.title}...`);

  const NOTION_DB_ID = process.env.NOTION_MEETINGS_DB || 'YOUR_MEETINGS_DB_ID';

  const children: Record<string, unknown>[] = [
    // معلومات أساسية
    h2Block('معلومات الاجتماع'),
    textBlock(`التاريخ: ${meeting.date} | المكان: ${meeting.location}`),
    textBlock(`رئيس الاجتماع: ${meeting.chair}`),
    textBlock(`الحاضرون: ${meeting.attendees.join(' | ')}`),

    // جدول الأعمال
    h2Block('جدول الأعمال'),
    ...meeting.agenda.map((item, i) => bulletBlock(`${i + 1}. ${item}`)),

    // القرارات
    h2Block('القرارات المتخذة'),
    ...meeting.decisions.map((d) => bulletBlock(d)),

    // مهام المتابعة
    h2Block('مهام المتابعة'),
    ...meeting.actionItems.map((a) =>
      bulletBlock(`${a.task} — المسؤول: ${a.assignedTo} | الاستحقاق: ${a.dueDate} | الأولوية: ${a.priority}`)
    ),
  ];

  // إضافة ملاحظات إن وجدت
  if (meeting.notes) {
    children.push(h2Block('ملاحظات إضافية'));
    children.push(textBlock(meeting.notes));
  }

  const result = await callWayStation('notion_create_page', {
    parent: { database_id: NOTION_DB_ID },
    properties: {
      'عنوان الاجتماع': { title : [{ text: { content: meeting.title } }] },
      'التاريخ'        : { date  : { start: meeting.date } },
      'رئيس الاجتماع'  : { rich_text: [{ text: { content: meeting.chair } }] },
      'عدد الحاضرين'   : { number: meeting.attendees.length },
      'عدد القرارات'   : { number: meeting.decisions.length },
      'مهام متابعة'    : { number: meeting.actionItems.length },
      'الحالة'         : { select: { name: 'مكتمل' } },
    },
    children,
  }) as { id?: string };

  const pageId = result?.id || 'unknown';
  console.log(`[Notion] تم إنشاء المحضر. معرّف: ${pageId}`);
  return pageId;
}

// ─── الخطوة 2: إنشاء مهام المتابعة في Monday.com ─────────────
async function createMondayActionItems(
  meeting: MeetingData,
  notionPageId: string
): Promise<void> {
  console.log(`[Monday] إنشاء ${meeting.actionItems.length} مهمة متابعة...`);

  const MONDAY_BOARD_ID = process.env.MONDAY_BOARD_ID || 'YOUR_MONDAY_BOARD_ID';

  for (const item of meeting.actionItems) {
    await callWayStation('monday_create_item', {
      board_id  : MONDAY_BOARD_ID,
      group_id  : 'مهام_الاجتماعات',
      item_name : `[${meeting.meetingId}] ${item.task}`,
      column_values: {
        status  : { label: 'لم تبدأ' },
        date    : { date : item.dueDate },
        text    : item.assignedTo,
        priority: { label: item.priority },
        link    : {
          url : `https://notion.so/${notionPageId.replace(/-/g, '')}`,
          text: `محضر: ${meeting.title}`,
        },
      },
    });
    console.log(`  [Monday] ✓ تم إنشاء: ${item.task}`);
  }

  console.log('[Monday] تم إنشاء جميع المهام.');
}

// ─── الخطوة 3: إرسال ملخص عبر Slack ─────────────────────────
async function sendSlackSummary(
  meeting: MeetingData,
  notionPageId: string
): Promise<void> {
  console.log('[Slack] إرسال ملخص الاجتماع...');

  const SLACK_CHANNEL = process.env.SLACK_CHANNEL || '#اجتماعات';

  const decisionsText = meeting.decisions
    .slice(0, 5)
    .map((d, i) => `> ${i + 1}. ${d}`)
    .join('\\n');

  const actionsText = meeting.actionItems
    .slice(0, 5)
    .map((a) => `> • ${a.task} ← *${a.assignedTo}* (${a.dueDate})`)
    .join('\\n');

  const message =
    `*محضر اجتماع: ${meeting.title}*\\n` +
    `> التاريخ: ${meeting.date} | رئيس الاجتماع: ${meeting.chair}\\n` +
    `> الحاضرون: ${meeting.attendees.length} شخص\\n\\n` +
    `*القرارات الرئيسية (${meeting.decisions.length}):*\\n${decisionsText}\\n\\n` +
    `*مهام المتابعة (${meeting.actionItems.length}):*\\n${actionsText}\\n\\n` +
    `<https://notion.so/${notionPageId.replace(/-/g, '')}|فتح المحضر الكامل في Notion>`;

  await callWayStation('slack_post_message', {
    channel: SLACK_CHANNEL,
    text   : message,
    mrkdwn : true,
  });

  console.log('[Slack] تم إرسال الملخص.');
}

// ─── الدالة الرئيسية ─────────────────────────────────────────
async function runMeetingSummaryWorkflow(meeting: MeetingData): Promise<void> {
  console.log('\n========================================');
  console.log('  بدء سير عمل أتمتة محضر الاجتماع');
  console.log('========================================\n');

  try {
    const notionPageId = await createMeetingMinutes(meeting);
    await createMondayActionItems(meeting, notionPageId);
    await sendSlackSummary(meeting, notionPageId);

    console.log('\n========================================');
    console.log('  اكتمل سير العمل بنجاح');
    console.log('========================================\n');
  } catch (error) {
    console.error('\n[خطأ] فشل تنفيذ سير العمل:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// ─── مثال تشغيل ──────────────────────────────────────────────
// npx ts-node workflows/meeting_summary.ts

const exampleMeeting: MeetingData = {
  meetingId : 'MTG-2026-021',
  title     : 'اجتماع مجلس الأعمال السعودي-اليمني - مارس 2026',
  date      : '2026-03-21',
  location  : 'جدة - مقر الغرفة التجارية',
  chair     : 'د. عبدالله بن محفوظ',
  attendees : [
    'د. عبدالله بن محفوظ',
    'م. أحمد الزبيدي',
    'أ. خالد العمري',
    'أ. محمد البكري',
    'م. سارة الأحمدي',
  ],
  agenda: [
    'مراجعة محضر الاجتماع السابق',
    'تحديث مشاريع الاستثمار المشترك',
    'مناقشة فرص التصدير الجديدة',
    'متابعة القضايا القانونية المعلقة',
    'متفرقات',
  ],
  decisions: [
    'الموافقة على توسعة مشروع التصنيع المشترك بتمويل إضافي 5 مليون ر.س',
    'تشكيل لجنة فنية لدراسة فرص التصدير إلى السوق الأفريقية',
    'تكليف الفريق القانوني بمتابعة القضية رقم SA-YE-2026-001 خلال أسبوعين',
    'عقد الاجتماع القادم بتاريخ 2026-04-18',
  ],
  actionItems: [
    {
      task      : 'إعداد دراسة جدوى توسعة مشروع التصنيع',
      assignedTo: 'م. أحمد الزبيدي',
      dueDate   : '2026-04-05',
      priority  : 'عالية',
    },
    {
      task      : 'تشكيل لجنة التصدير وتحديد أعضائها',
      assignedTo: 'أ. خالد العمري',
      dueDate   : '2026-03-28',
      priority  : 'عالية',
    },
    {
      task      : 'متابعة القضية SA-YE-2026-001 وتقديم تقرير',
      assignedTo: 'د. عبدالله بن محفوظ',
      dueDate   : '2026-04-04',
      priority  : 'عالية',
    },
    {
      task      : 'إعداد دعوة وجدول أعمال الاجتماع القادم',
      assignedTo: 'أ. محمد البكري',
      dueDate   : '2026-04-10',
      priority  : 'متوسطة',
    },
  ],
  notes: 'تم الاتفاق على مشاركة التقارير المالية قبل الاجتماع القادم بـ 3 أيام عمل.',
};

runMeetingSummaryWorkflow(exampleMeeting);
