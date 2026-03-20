// ============================================================
// workflows/investment_risk_report.ts
// سكربت سير عمل: تقرير مخاطر الاستثمارات المتعثرة
// المؤلف: abm2030 | تاريخ الإنشاء: 2026-03-21
// الهدف: يسحب بيانات الاستثمارات من Airtable/Sheets، يحلل المخاطر،
//   ويولّد تقريراً في Notion مع إشعار Slack
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
interface Investment {
  id           : string;
  projectName  : string;
  country      : string;   // SA, YE, EG ...
  sector       : string;   // تصنيع، عقار، تجارة ...
  investedAmount: number;
  currentValue : number;
  startDate    : string;
  status       : 'نشط' | 'متعثر' | 'متوقف' | 'مُصفّى';
  partnerName  : string;
  notes        : string;
}

interface RiskAssessment {
  investment   : Investment;
  lossPercent  : number;
  riskLevel    : 'حرج' | 'عالي' | 'متوسط' | 'منخفض';
  recommendation: string;
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

// ─── الخطوة 1: جلب بيانات الاستثمارات من Airtable ────────────
async function fetchInvestments(): Promise<Investment[]> {
  console.log('[Airtable] جلب بيانات الاستثمارات...');

  const AIRTABLE_BASE_ID  = process.env.AIRTABLE_BASE_ID  || 'YOUR_BASE_ID';
  const AIRTABLE_TABLE    = process.env.AIRTABLE_TABLE     || 'Investments';

  const result = await callWayStation('airtable_list_records', {
    base_id   : AIRTABLE_BASE_ID,
    table_name: AIRTABLE_TABLE,
    filter    : "OR({status} = 'متعثر', {status} = 'متوقف')",
    sort      : [{ field: 'currentValue', direction: 'asc' }],
  }) as { records?: Array<{ fields: Record<string, unknown> }> };

  const records = result?.records || [];
  console.log(`[Airtable] تم جلب ${records.length} استثمار.`);

  return records.map((r: { fields: Record<string, unknown> }) => ({
    id            : String(r.fields['id'] || ''),
    projectName   : String(r.fields['projectName'] || ''),
    country       : String(r.fields['country'] || ''),
    sector        : String(r.fields['sector'] || ''),
    investedAmount: Number(r.fields['investedAmount'] || 0),
    currentValue  : Number(r.fields['currentValue'] || 0),
    startDate     : String(r.fields['startDate'] || ''),
    status        : r.fields['status'] as Investment['status'],
    partnerName   : String(r.fields['partnerName'] || ''),
    notes         : String(r.fields['notes'] || ''),
  }));
}

// ─── الخطوة 2: تحليل المخاطر ────────────────────────────────
function analyzeRisks(investments: Investment[]): RiskAssessment[] {
  console.log('[تحليل] حساب مؤشرات المخاطر...');

  return investments.map((inv) => {
    const lossPercent = inv.investedAmount > 0
      ? ((inv.investedAmount - inv.currentValue) / inv.investedAmount) * 100
      : 0;

    let riskLevel: RiskAssessment['riskLevel'];
    let recommendation: string;

    if (lossPercent >= 75) {
      riskLevel = 'حرج';
      recommendation = 'تصفية فورية أو إعادة هيكلة جذرية. يُنصح برفع الأمر للإدارة العليا.';
    } else if (lossPercent >= 50) {
      riskLevel = 'عالي';
      recommendation = 'مراجعة عقد الشراكة وتقييم خيارات التحكيم أو التفاوض.';
    } else if (lossPercent >= 25) {
      riskLevel = 'متوسط';
      recommendation = 'متابعة دورية مع الشريك ووضع خطة تعافي خلال 90 يوماً.';
    } else {
      riskLevel = 'منخفض';
      recommendation = 'مراقبة روتينية. لا حاجة لإجراء عاجل.';
    }

    return { investment: inv, lossPercent, riskLevel, recommendation };
  }).sort((a, b) => b.lossPercent - a.lossPercent);
}

// ─── الخطوة 3: إنشاء تقرير في Notion ────────────────────────
async function createNotionReport(assessments: RiskAssessment[]): Promise<string> {
  console.log('[Notion] إنشاء تقرير المخاطر...');

  const NOTION_DB_ID = process.env.NOTION_REPORTS_DB || 'YOUR_REPORTS_DB_ID';
  const today = new Date().toISOString().split('T')[0];

  const totalInvested = assessments.reduce((s, a) => s + a.investment.investedAmount, 0);
  const totalCurrent  = assessments.reduce((s, a) => s + a.investment.currentValue, 0);
  const totalLoss     = totalInvested - totalCurrent;
  const criticalCount = assessments.filter(a => a.riskLevel === 'حرج').length;
  const highCount     = assessments.filter(a => a.riskLevel === 'عالي').length;

  // بناء محتوى الصفحة
  const children: Record<string, unknown>[] = [
    {
      object: 'block', type: 'heading_2',
      heading_2: { rich_text: [{ type: 'text', text: { content: 'ملخص تنفيذي' } }] },
    },
    {
      object: 'block', type: 'paragraph',
      paragraph: {
        rich_text: [{ type: 'text', text: {
          content: `عدد الاستثمارات المتعثرة: ${assessments.length} | `
            + `إجمالي المستثمر: ${totalInvested.toLocaleString()} ر.س | `
            + `القيمة الحالية: ${totalCurrent.toLocaleString()} ر.س | `
            + `إجمالي الخسائر: ${totalLoss.toLocaleString()} ر.س | `
            + `حرج: ${criticalCount} | عالي: ${highCount}`
        } }],
      },
    },
    {
      object: 'block', type: 'heading_2',
      heading_2: { rich_text: [{ type: 'text', text: { content: 'تفاصيل الاستثمارات' } }] },
    },
  ];

  // إضافة كل استثمار كفقرة
  for (const a of assessments) {
    children.push({
      object: 'block', type: 'heading_3',
      heading_3: {
        rich_text: [{ type: 'text', text: {
          content: `[${a.riskLevel}] ${a.investment.projectName} - ${a.investment.country}`
        } }],
      },
    });
    children.push({
      object: 'block', type: 'paragraph',
      paragraph: {
        rich_text: [{ type: 'text', text: {
          content: `الشريك: ${a.investment.partnerName} | `
            + `القطاع: ${a.investment.sector} | `
            + `المستثمر: ${a.investment.investedAmount.toLocaleString()} ر.س | `
            + `الحالي: ${a.investment.currentValue.toLocaleString()} ر.س | `
            + `نسبة الخسارة: ${a.lossPercent.toFixed(1)}%\n`
            + `التوصية: ${a.recommendation}`
        } }],
      },
    });
  }

  const result = await callWayStation('notion_create_page', {
    parent: { database_id: NOTION_DB_ID },
    properties: {
      'عنوان التقرير': { title: [{ text: { content: `تقرير مخاطر الاستثمارات - ${today}` } }] },
      'التاريخ'      : { date: { start: today } },
      'النوع'        : { select: { name: 'تقرير مخاطر' } },
      'الحالة'       : { select: { name: 'جديد' } },
    },
    children,
  }) as { id?: string };

  const pageId = result?.id || 'unknown';
  console.log(`[Notion] تم إنشاء التقرير. معرّف: ${pageId}`);
  return pageId;
}

// ─── الخطوة 4: إشعار Slack ──────────────────────────────────
async function sendSlackAlert(assessments: RiskAssessment[], notionPageId: string): Promise<void> {
  console.log('[Slack] إرسال تنبيه المخاطر...');

  const SLACK_CHANNEL = process.env.SLACK_CHANNEL || '#استثمارات';
  const criticalCount = assessments.filter(a => a.riskLevel === 'حرج').length;
  const highCount     = assessments.filter(a => a.riskLevel === 'عالي').length;
  const totalLoss     = assessments.reduce((s, a) =>
    s + (a.investment.investedAmount - a.investment.currentValue), 0);

  const topRisks = assessments.slice(0, 3).map(a =>
    `> *${a.investment.projectName}* (${a.investment.country}) - خسارة ${a.lossPercent.toFixed(1)}% [${a.riskLevel}]`
  ).join('\\n');

  const message =
    `*تقرير مخاطر الاستثمارات المتعثرة*\\n` +
    `> إجمالي الخسائر: *${totalLoss.toLocaleString()} ر.س*\\n` +
    `> حرج: *${criticalCount}* | عالي: *${highCount}* | إجمالي: *${assessments.length}*\\n\\n` +
    `*أعلى 3 مخاطر:*\\n${topRisks}\\n\\n` +
    `<https://notion.so/${notionPageId.replace(/-/g, '')}|فتح التقرير الكامل في Notion>`;

  await callWayStation('slack_post_message', {
    channel: SLACK_CHANNEL,
    text   : message,
    mrkdwn : true,
  });

  console.log('[Slack] تم إرسال التنبيه.');
}

// ─── الدالة الرئيسية ─────────────────────────────────────────
async function runInvestmentRiskReport(): Promise<void> {
  console.log('\n========================================');
  console.log('  بدء سير عمل تقرير مخاطر الاستثمارات');
  console.log('========================================\n');

  try {
    const investments  = await fetchInvestments();
    if (investments.length === 0) {
      console.log('[معلومة] لا توجد استثمارات متعثرة حالياً.');
      return;
    }
    const assessments  = analyzeRisks(investments);
    const notionPageId = await createNotionReport(assessments);
    await sendSlackAlert(assessments, notionPageId);

    console.log('\n========================================');
    console.log('  اكتمل التقرير بنجاح');
    console.log('========================================\n');
  } catch (error) {
    console.error('\n[خطأ] فشل تنفيذ سير العمل:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// ─── تشغيل ───────────────────────────────────────────────────
// npx ts-node workflows/investment_risk_report.ts
runInvestmentRiskReport();
