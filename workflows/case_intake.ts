// ============================================================
// workflows/case_intake.ts
// سكربت سير عمل: استقبال قضية جديدة عبر WayStation MCP
// المؤلف: abm2030 | تاريخ الإنشاء: 2026-03-21
// الهدف: عند إضافة قضية جديدة يقوم السكربت بـ:
//   1. إنشاء صفحة قضية في Notion
//   2. إنشاء مهمة متابعة في Monday.com
//   3. إرسال إشعار ملخص عبر Slack
// ============================================================

import fetch from 'node-fetch';

// ─── إعدادات الاتصال بـ WayStation ───────────────────────────
const WAYSTATION_API = process.env.WAY_BASE || 'https://waystation.ai';
const WAY_KEY        = process.env.WAY_KEY  || '';

if (!WAY_KEY) {
  console.error('[خطأ] متغير WAY_KEY غير مُعيَّن. أضفه في بيئة التشغيل.');
  process.exit(1);
}

// ─── نوع بيانات القضية ────────────────────────────────────────
interface CaseData {
  caseId       : string;  // رقم القضية
  title        : string;  // عنوان القضية
  clientName   : string;  // اسم الموكّل
  country      : string;  // الدولة (SA / YE / EG ...)
  caseType     : string;  // نوع القضية (تجاري / استثماري / عقاري ...)
  priority     : 'عالية' | 'متوسطة' | 'منخفضة';
  filingDate   : string;  // تاريخ التقديم ISO 8601
  assignedTo   : string;  // المحامي/الباحث المسؤول
  notes        : string;  // ملاحظات أولية
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
      params: {
        name : toolName,
        input: toolInput,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`[WayStation] فشل الطلب: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

// ─── الخطوة 1: إنشاء صفحة القضية في Notion ──────────────────
async function createNotionPage(caseData: CaseData): Promise<string> {
  console.log(`[Notion] إنشاء صفحة للقضية: ${caseData.caseId}...`);

  // استبدل DATABASE_ID بمعرّف قاعدة بيانات Notion الخاصة بك
  const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID || 'YOUR_NOTION_DB_ID';

  const result = await callWayStation('notion_create_page', {
    parent  : { database_id: NOTION_DATABASE_ID },
    properties: {
      'رقم القضية' : { title   : [{ text: { content: caseData.caseId   } }] },
      'العنوان'    : { rich_text: [{ text: { content: caseData.title    } }] },
      'الموكّل'    : { rich_text: [{ text: { content: caseData.clientName } }] },
      'الدولة'     : { select  : { name: caseData.country   } },
      'نوع القضية' : { select  : { name: caseData.caseType  } },
      'الأولوية'   : { select  : { name: caseData.priority  } },
      'تاريخ التقديم': { date  : { start: caseData.filingDate } },
      'المسؤول'    : { rich_text: [{ text: { content: caseData.assignedTo } }] },
      'الحالة'     : { select  : { name: 'جديدة - قيد المراجعة' } },
    },
    children: [
      {
        object: 'block',
        type  : 'heading_2',
        heading_2: {
          rich_text: [{ type: 'text', text: { content: 'ملاحظات أولية' } }],
        },
      },
      {
        object: 'block',
        type  : 'paragraph',
        paragraph: {
          rich_text: [{ type: 'text', text: { content: caseData.notes || 'لا توجد ملاحظات بعد.' } }],
        },
      },
    ],
  }) as { id?: string };

  const pageId = result?.id || 'unknown';
  console.log(`[Notion] تم إنشاء الصفحة بنجاح. معرّف الصفحة: ${pageId}`);
  return pageId;
}

// ─── الخطوة 2: إنشاء مهمة متابعة في Monday.com ──────────────
async function createMondayTask(caseData: CaseData, notionPageId: string): Promise<void> {
  console.log(`[Monday] إنشاء مهمة متابعة للقضية: ${caseData.caseId}...`);

  // استبدل BOARD_ID بمعرّف لوحة Monday الخاصة بك
  const MONDAY_BOARD_ID = process.env.MONDAY_BOARD_ID || 'YOUR_MONDAY_BOARD_ID';

  await callWayStation('monday_create_item', {
    board_id  : MONDAY_BOARD_ID,
    group_id  : 'قضايا_جديدة', // اسم المجموعة في اللوحة
    item_name : `[${caseData.country}] ${caseData.caseId} - ${caseData.title}`,
    column_values: {
      status    : { label: 'قيد المراجعة' },
      date      : { date : caseData.filingDate },
      text      : caseData.assignedTo,
      priority  : { label: caseData.priority },
      link      : {
        url  : `https://notion.so/${notionPageId.replace(/-/g, '')}`,
        text : 'صفحة Notion',
      },
    },
  });

  console.log('[Monday] تم إنشاء المهمة بنجاح.');
}

// ─── الخطوة 3: إرسال إشعار Slack ────────────────────────────
async function sendSlackNotification(caseData: CaseData, notionPageId: string): Promise<void> {
  console.log('[Slack] إرسال إشعار بالقضية الجديدة...');

  // استبدل SLACK_CHANNEL بمعرّف القناة
  const SLACK_CHANNEL = process.env.SLACK_CHANNEL || '#قضايا-جديدة';

  const message =
    `*قضية جديدة دخلت المنظومة*\n` +
    `> *رقم القضية:* ${caseData.caseId}\n` +
    `> *العنوان:* ${caseData.title}\n` +
    `> *الموكّل:* ${caseData.clientName}\n` +
    `> *الدولة:* ${caseData.country} | *النوع:* ${caseData.caseType}\n` +
    `> *الأولوية:* ${caseData.priority}\n` +
    `> *المسؤول:* ${caseData.assignedTo}\n` +
    `> <https://notion.so/${notionPageId.replace(/-/g, '')}|فتح صفحة Notion>`;

  await callWayStation('slack_post_message', {
    channel: SLACK_CHANNEL,
    text   : message,
    mrkdwn : true,
  });

  console.log('[Slack] تم إرسال الإشعار بنجاح.');
}

// ─── الدالة الرئيسية: تنفيذ سير العمل الكامل ────────────────
async function runCaseIntakeWorkflow(caseData: CaseData): Promise<void> {
  console.log('\n========================================');
  console.log('  بدء سير عمل استقبال القضية الجديدة');
  console.log('========================================\n');

  try {
    // الخطوة 1: Notion
    const notionPageId = await createNotionPage(caseData);

    // الخطوة 2: Monday
    await createMondayTask(caseData, notionPageId);

    // الخطوة 3: Slack
    await sendSlackNotification(caseData, notionPageId);

    console.log('\n========================================');
    console.log('  اكتمل سير العمل بنجاح');
    console.log('========================================\n');

  } catch (error) {
    console.error('\n[خطأ] فشل تنفيذ سير العمل:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// ─── مثال تشغيل: بيانات قضية نموذجية ────────────────────────
// لتشغيل السكربت من سطر الأوامر:
//   npx ts-node workflows/case_intake.ts
//
// يمكنك تعديل البيانات أدناه أو استيراد البيانات من ملف JSON

const exampleCase: CaseData = {
  caseId     : 'SA-YE-2026-001',
  title      : 'نزاع استثماري - مشروع تصنيعي مشترك',
  clientName : 'شركة البناء والتطوير السعودية-اليمنية',
  country    : 'SA',
  caseType   : 'استثماري تجاري',
  priority   : 'عالية',
  filingDate : '2026-03-21',
  assignedTo : 'د. عبدالله بن محفوظ',
  notes      : 'قضية تتعلق بنزاع حول تقاسم الأرباح في مشروع مشترك. يتطلب مراجعة عقد الشراكة المبرم 2024 وتقييم الاستثمارات الراسية.',
};

runCaseIntakeWorkflow(exampleCase);
