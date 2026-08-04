/**
 * fiscal/fiscal-i18n.js — HAPI 11: shqip (sq) + serbisht (sr) për modulin fiskal.
 * Ndikon VETËM kuponin fiskal + UI SEF — jo tekstet e tjera të KAFENE.
 */
const { getFiscalSettings, saveFiscalSettings } = require("./fiscal-config");

const TRANSLATIONS = Object.freeze({
  sq: Object.freeze({
    // —— Kupon ——
    receipt_fiscal: "KUPON FISKAL",
    KUPON_FISKAL: "KUPON FISKAL",
    receipt_non_fiscal: "KUPON JO FISKAL",
    receipt_corrective: "KUPON KORRIGJUES",
    reference: "Referencë:",
    operator: "Operator:",
    coupon_no: "Kupon Nr:",
    coupon_type: "Tipi kuponit:",
    type_label: "Tipi:",
    item: "Artikulli",
    qty: "Sasia",
    price: "Çmimi",
    value: "Vlera",
    vat: "TVSH",
    items_header_left: "Artikulli  Sasia  Çmimi",
    items_header_right: "Vlera TVSH",
    subtotal: "Nën-totali",
    NEN_TOTALI: "Nën-totali",
    discount: "Zbritja",
    surcharge: "Rritja",
    line_discount: "Zbritje artikulli",
    line_surcharge: "Rritje artikulli",
    total_to_pay: "TOTALI NE EURO",
    TOTALI_NE_EURO: "TOTALI NE EURO",
    total_without_tax: "TOT. PA TVSH",
    TOT_PA_TVSH: "TOT. PA TVSH",
    tax_by_rates: "Tatimi sipas normave:",
    rate_a: "TVSH A=0.00%",
    rate_d: "TVSH D=8.00%",
    rate_e: "TVSH E=18.00%",
    payment: "Pagesa:",
    PAGESA: "Pagesa:",
    payment_method_line: "MËNYRA E PAGESËS:",
    payment_mode_cash: "KESH",
    payment_mode_pos: "POS",
    payment_mode_voucher: "VAUÇER",
    payment_mode_cheque: "ÇEK",
    payment_mode_other: "TJETËR",
    amount_paid: "Shuma e paguar",
    change_due: "KUSUR",
    pay_cash: "PARA TE GATSHME",
    PARA_E_GATSHME: "PARA TE GATSHME",
    fiscal_no_label: "NR. FISKAL:",
    nuikf_label: "NUIKF:",
    fiscal_coupon_nr: "KUPON FISKAL NR.",
    fiscal_coupon_daily_nr: "KUPON FISKAL DITOR NR.",
    e_kuponi: "e-kuponi",
    phone_label: "Tel:",
    pay_debit: "Debit kartelë",
    pay_credit: "Kredit kartelë",
    pay_bank: "Llogari bankare",
    pay_voucher: "Vauçer",
    pay_check: "Çek",
    pay_sms: "SMS",
    offline: "*** OFFLINE ***",
    power_loss: "MUNGESË RRYME",
    power_loss_banner: "*** MUNGESË RRYME ***",
    fiscal_logo: "Logo Fiskale",
    type_regular: "i rregullt",
    type_cancel: "Anulim",
    type_return: "Kthim malli",
    type_storno: "Storno",
    nui_label: "NUI:",
    vat_no_label: "NR. TVSH:",
    date_label: "Data:",
    time_label: "Ora:",
    sef_no: "Nr. SEF:",

    // —— UI Fiskalizimi ——
    fiscalization: "Fiskalizimi",
    fiscalization_desc: "SEF / ATK — aktivizohet vetëm kur toggle është ON. Të dhënat ruhen lokalisht.",
    enable_fiscalization: "Aktivizo Fiskalizimin",
    print_mode_label: "Printimi i kuponit fiskal",
    print_mode_replace: "Zëvendëso — vetëm kupon fiskal në mbyllje (kuponi i porosisë printohet gjithmonë)",
    print_mode_addon: "Shtesë — kupon normal mbylljeje + kupon fiskal",
    taxpayer_nui_label: "NUI (9 shifra)",
    taxpayer_nui_placeholder: "p.sh. 123456789",
    taxpayer_nf_label: "Numri Fiskal",
    taxpayer_nf_placeholder: "Numri fiskal",
    taxpayer_vat_label: "Nr. TVSH",
    taxpayer_vat_placeholder: "Numri i TVSH-së",
    taxpayer_legal_name_label: "Emri ligjor i biznesit",
    taxpayer_legal_name_placeholder: "Emri ligjor",
    taxpayer_address_label: "Adresa e biznesit",
    taxpayer_address_placeholder: "Adresa",
    business_unit_label: "Nr. Njësisë",
    business_unit_placeholder: "Nr. njësisë së biznesit",
    unit_number_label: "Numri i Njësisë (ARBK)",
    unit_number_placeholder: "p.sh. 5130484 — nga ARBK",
    unit_name_label: "Emri i njësisë",
    unit_name_placeholder: "Emri i degës / njësisë",
    unit_phone_label: "Telefoni i njësisë",
    unit_phone_placeholder: "p.sh. 044 123 456",
    pos_id_label: "Nr. POS-it",
    pos_id_placeholder: "Nr. POS-it",
    fiscalization_number_label: "Nr. Fiskalizimit",
    fiscalization_number_placeholder: "Plotësohet nga ATK",
    sef_code_label: "Kodi SEF",
    sef_code_placeholder: "Plotësohet pas certifikimit",
    language_label: "Gjuha",
    lang_sq: "Shqip",
    lang_sr: "Serbisht",
    save_fiscalization: "Ruaj Fiskalizimin",
    corrective_coupon: "Kupon Korrigjues",
    test_fiscalization: "Testo Fiskalizimin",
    test_fiscalization_100: "Testo 100 herë",
    print_test_coupon: "Printo Kupon Provë",
    view_fiscal_receipts: "Shiko Kuponët Fiskalë",
    self_test_title: "Rezultati i testit fiskal (lokal — pa ATK)",
    self_test_battery_title: "Testi 100 herë — përmbledhje",
    audit_log_title: "Audit Log (WRITE-ONCE)",
    audit_from: "Nga",
    audit_to: "Deri",
    export_audit_log: "Eksporto Audit Log",
    export_audit_csv: "Eksporto Audit Log (CSV)",
    export_audit_pdf: "Eksporto Audit Log (PDF)",
    fiscal_receipts_title: "Kuponët Fiskalë",
    fiscal_receipts_sub: "Të gjitha kuponët nga fiscal_receipts — më i riu lart. Vetëm lexim (WRITE-ONCE).",
    fiscal_receipt_view_title: "Kupon Fiskal",
    close: "Mbyll",
    loading: "Duke ngarkuar…",
    col_nuikf: "NUIKF",
    col_daily: "Nr. ditor",
    col_datetime: "Data / Ora",
    col_type: "Tipi",
    col_total: "Totali",
    col_payment: "Pagesa",
    col_operator: "Operatori",
    col_status: "Statusi",
    correction_sub: "Shkruani NUIKF e kuponit origjinal. Kuponi i ri ruhet write-once dhe printohet.",
    original_nuikf: "NUIKF origjinal",
    original_nuikf_placeholder: "16 karaktere",
    lookup: "Kërko",
    correction_type: "Tipi i korrigjimit",
    return_items: "Artikujt për kthim",
    reason_label: "Arsyeja",
    reason_placeholder: "Arsyeja e korrigjimit",
    confirm_print: "Konfirmo & Printo",
    fiscal_on_saved: "Fiskalizimi ON (u ruajt)",
    fiscal_off_saved: "Fiskalizimi OFF (u ruajt)",
    print_mode_replace_msg: "Vetëm kupon fiskal",
    print_mode_addon_msg: "Normal + fiskal",
    saved_ok: "U ruajt!",
    nui_invalid: "NUI duhet të ketë saktësisht 9 shifra",
    lang_saved_sq: "Gjuha: Shqip (u ruajt)",
    lang_saved_sr: "Gjuha: Serbisht (u ruajt)",
    lang_save_fail: "Gjuha nuk u ruajt",
    view: "Shiko",
    receipts_empty: "Nuk ka kuponë fiskalë ende.",
    receipts_count: "{n} kuponë",
    receipts_count_one: "1 kupon",
    status_sent: "Dërguar te ATK",
    status_pending: "Pa dërguar",
    status_offline: "Offline",
    enter_nuikf: "Shkruani NUIKF",
    searching: "Duke kërkuar...",
    not_found: "Nuk u gjet",
    enter_reason: "Shkruani arsyen",
    select_return_item: "Zgjidhni të paktën një artikull për kthim",
    lookup_first: "Kërkoni fillimisht kuponin origjinal",
    creating: "Duke krijuar...",
    has_correction: "Ky kupon ka tashmë korrigjim(e).",
    details_date: "Data:",
    details_operator: "Operator:",
    details_items: "Artikuj:",
    details_total: "Totali:",
    details_payment: "Pagesa:",
    payment_modal_title: "Mënyra e pagesës",
    payment_modal_sub: "Zgjidhni para printimit të kuponit. Default: Para e gatshme.",
    payment_modal_cancel: "Anulo",
    business_fallback: "Biznesi",
    audit_pick_dates: "Zgjidhni datat Nga / Deri",
    audit_exporting: "Duke eksportuar...",
    empty: "(bosh)",
  }),
  sr: Object.freeze({
    // —— Kupon ——
    receipt_fiscal: "FISKALNI KUPON",
    KUPON_FISKAL: "FISKALNI KUPON",
    receipt_non_fiscal: "NEFISKALNI KUPON",
    receipt_corrective: "KOREKTIVNI KUPON",
    reference: "Referenca:",
    operator: "Operater:",
    coupon_no: "Kupon Br:",
    coupon_type: "Tip kupona:",
    type_label: "Tip:",
    item: "Artikal",
    qty: "Količina",
    price: "Cena",
    value: "Vrednost",
    vat: "PDV",
    items_header_left: "Artikal  Kol.  Cena",
    items_header_right: "Vrednost PDV",
    subtotal: "Međuzbir",
    NEN_TOTALI: "Međuzbir",
    discount: "Popust",
    surcharge: "Poskupljenje",
    line_discount: "Popust na artikal",
    line_surcharge: "Poskupljenje artikla",
    total_to_pay: "UKUPNO ZA PLAĆANJE",
    TOTALI_NE_EURO: "UKUPNO ZA PLAĆANJE",
    total_without_tax: "UKUP. BEZ PDV",
    TOT_PA_TVSH: "UKUP. BEZ PDV",
    tax_by_rates: "Porez po stopama:",
    rate_a: "PDV A=0.00%",
    rate_d: "PDV D=8.00%",
    rate_e: "PDV E=18.00%",
    payment: "Plaćanje:",
    PAGESA: "Plaćanje:",
    payment_method_line: "NAČIN PLAĆANJA:",
    payment_mode_cash: "KES",
    payment_mode_pos: "POS",
    payment_mode_voucher: "VAUČER",
    payment_mode_cheque: "ČEK",
    payment_mode_other: "DRUGO",
    amount_paid: "Plaćeni iznos",
    change_due: "KUSUR",
    pay_cash: "Gotovina",
    PARA_E_GATSHME: "Gotovina",
    fiscal_no_label: "FISKALNI BR:",
    nuikf_label: "NUIKF:",
    fiscal_coupon_nr: "FISKALNI KUPON BR.",
    fiscal_coupon_daily_nr: "FISKALNI KUPON DNEVNI BR.",
    e_kuponi: "e-kupon",
    phone_label: "Tel:",
    pay_debit: "Debitna kartica",
    pay_credit: "Kreditna kartica",
    pay_bank: "Bankarski račun",
    pay_voucher: "Vaučer",
    pay_check: "Ček",
    pay_sms: "SMS",
    offline: "*** OFFLINE ***",
    power_loss: "NEDOSTATAK STRUJE",
    power_loss_banner: "*** NEDOSTATAK STRUJE ***",
    fiscal_logo: "Fiskalni logo",
    type_regular: "redovan",
    type_cancel: "Storniranje",
    type_return: "Povrat robe",
    type_storno: "Storno",
    nui_label: "PIB:",
    vat_no_label: "PDV BR:",
    date_label: "Datum:",
    time_label: "Vreme:",
    sef_no: "SEF br:",

    // —— UI Fiskalizimi ——
    fiscalization: "Fiskalizacija",
    fiscalization_desc: "SEF / ATK — aktivira se samo kada je prekidač ON. Podaci se čuvaju lokalno.",
    enable_fiscalization: "Aktiviraj fiskalizaciju",
    print_mode_label: "Štampanje fiskalnog kupona",
    print_mode_replace: "Zameni — samo fiskalni kupon pri zatvaranju (kupon porudžbine se štampa uvek)",
    print_mode_addon: "Dodatak — običan kupon zatvaranja + fiskalni kupon",
    taxpayer_nui_label: "PIB (9 cifara)",
    taxpayer_nui_placeholder: "npr. 123456789",
    taxpayer_nf_label: "Fiskalni broj",
    taxpayer_nf_placeholder: "Fiskalni broj",
    taxpayer_vat_label: "PDV broj",
    taxpayer_vat_placeholder: "PDV broj",
    taxpayer_legal_name_label: "Pravno ime preduzeća",
    taxpayer_legal_name_placeholder: "Pravno ime",
    taxpayer_address_label: "Adresa preduzeća",
    taxpayer_address_placeholder: "Adresa",
    business_unit_label: "Broj jedinice",
    business_unit_placeholder: "Broj poslovne jedinice",
    unit_number_label: "Broj jedinice (ARBK)",
    unit_number_placeholder: "npr. 5130484 — iz ARBK",
    unit_name_label: "Ime jedinice",
    unit_name_placeholder: "Ime poslovne jedinice / ogranka",
    unit_phone_label: "Telefon jedinice",
    unit_phone_placeholder: "npr. 044 123 456",
    pos_id_label: "Broj POS-a",
    pos_id_placeholder: "Broj POS-a",
    fiscalization_number_label: "Broj fiskalizacije",
    fiscalization_number_placeholder: "Popunjava ATK",
    sef_code_label: "SEF kod",
    sef_code_placeholder: "Popunjava se posle sertifikacije",
    language_label: "Jezik",
    lang_sq: "Albanski",
    lang_sr: "Srpski",
    save_fiscalization: "Sačuvaj fiskalizaciju",
    corrective_coupon: "Korektivni kupon",
    test_fiscalization: "Testiraj fiskalizaciju",
    test_fiscalization_100: "Testiraj 100 puta",
    print_test_coupon: "Štampaj probni kupon",
    view_fiscal_receipts: "Prikaži fiskalne kupone",
    self_test_title: "Rezultat fiskalnog testa (lokalno — bez ATK)",
    self_test_battery_title: "Test 100 puta — rezime",
    audit_log_title: "Revizijski log (WRITE-ONCE)",
    audit_from: "Od",
    audit_to: "Do",
    export_audit_log: "Izvoz revizijskog loga",
    export_audit_csv: "Izvoz revizijskog loga (CSV)",
    export_audit_pdf: "Izvoz revizijskog loga (PDF)",
    fiscal_receipts_title: "Fiskalni kuponi",
    fiscal_receipts_sub: "Svi kuponi iz fiscal_receipts — najnoviji gore. Samo čitanje (WRITE-ONCE).",
    fiscal_receipt_view_title: "Fiskalni kupon",
    close: "Zatvori",
    loading: "Učitavanje…",
    col_nuikf: "NUIKF",
    col_daily: "Dnevni br.",
    col_datetime: "Datum / Vreme",
    col_type: "Tip",
    col_total: "Ukupno",
    col_payment: "Plaćanje",
    col_operator: "Operater",
    col_status: "Status",
    correction_sub: "Unesite NUIKF originalnog kupona. Novi kupon se čuva write-once i štampa.",
    original_nuikf: "Originalni NUIKF",
    original_nuikf_placeholder: "16 karaktera",
    lookup: "Pretraži",
    correction_type: "Tip korekcije",
    return_items: "Artikli za povrat",
    reason_label: "Razlog",
    reason_placeholder: "Razlog korekcije",
    confirm_print: "Potvrdi & Štampaj",
    fiscal_on_saved: "Fiskalizacija ON (sačuvano)",
    fiscal_off_saved: "Fiskalizacija OFF (sačuvano)",
    print_mode_replace_msg: "Samo fiskalni kupon",
    print_mode_addon_msg: "Običan + fiskalni",
    saved_ok: "Sačuvano!",
    nui_invalid: "PIB mora imati tačno 9 cifara",
    lang_saved_sq: "Jezik: Albanski (sačuvano)",
    lang_saved_sr: "Jezik: Srpski (sačuvano)",
    lang_save_fail: "Jezik nije sačuvan",
    view: "Prikaži",
    receipts_empty: "Još nema fiskalnih kupona.",
    receipts_count: "{n} kupona",
    receipts_count_one: "1 kupon",
    status_sent: "Poslato ATK",
    status_pending: "Nije poslato",
    status_offline: "Offline",
    enter_nuikf: "Unesite NUIKF",
    searching: "Pretraga...",
    not_found: "Nije pronađeno",
    enter_reason: "Unesite razlog",
    select_return_item: "Izaberite bar jedan artikal za povrat",
    lookup_first: "Prvo potražite originalni kupon",
    creating: "Kreiranje...",
    has_correction: "Ovaj kupon već ima korekciju/e.",
    details_date: "Datum:",
    details_operator: "Operater:",
    details_items: "Artikli:",
    details_total: "Ukupno:",
    details_payment: "Plaćanje:",
    payment_modal_title: "Način plaćanja",
    payment_modal_sub: "Izaberite pre štampanja kupona. Podrazumevano: Gotovina.",
    payment_modal_cancel: "Otkaži",
    business_fallback: "Preduzeće",
    audit_pick_dates: "Izaberite datume Od / Do",
    audit_exporting: "Izvoz...",
    empty: "(prazno)",
  }),
});

const PAYMENT_KEYS = Object.freeze({
  cash: "pay_cash",
  debit_card: "pay_debit",
  credit_card: "pay_credit",
  bank_account: "pay_bank",
  voucher: "pay_voucher",
  check: "pay_check",
  sms: "pay_sms",
  karte: "pay_debit",
});

const RECEIPT_TYPE_KEYS = Object.freeze({
  regular: "type_regular",
  cancel: "type_cancel",
  return: "type_return",
  storno: "type_storno",
});

/** Cache në memorie — default sq */
let _langCache = "sq";
/** Kur vendoset, t() e përdor këtë (i bllokuar për sesionin e printimit). */
let _langOverride = null;

function normalizeLang(lang) {
  const v = String(lang || "")
    .trim()
    .toLowerCase();
  return v === "sr" ? "sr" : "sq";
}

function readLanguageFromDb() {
  try {
    const s = getFiscalSettings();
    return normalizeLang(s && s.language);
  } catch (e) {
    console.warn("[fiscal-i18n] readLanguageFromDb:", e.message || e);
    return _langCache || "sq";
  }
}

/**
 * Lexon gjuhën nga fiscal_settings (ose override) para gjenerimit të kuponit.
 * Gjithmonë bllokon gjuhën në _langOverride që t() të jetë i qëndrueshëm.
 */
function syncLanguageFromSettings(overrideLang) {
  if (overrideLang != null && String(overrideLang).trim() !== "") {
    _langCache = normalizeLang(overrideLang);
  } else {
    _langCache = readLanguageFromDb();
  }
  _langOverride = _langCache;
  return _langCache;
}

/**
 * Gjuha aktuale: override (nëse ka) → fiscal_settings.language → sq.
 */
function getCurrentLanguage() {
  if (_langOverride != null) return normalizeLang(_langOverride);
  _langCache = readLanguageFromDb();
  return _langCache;
}

/**
 * Ndrysho gjuhën ('sq' | 'sr') dhe ruaje në fiscal_settings.
 * opts.persist=false → vetëm override në memorie (teste).
 */
function setLanguage(lang, opts = {}) {
  const next = normalizeLang(lang);
  _langCache = next;
  _langOverride = next;
  const persist = opts.persist !== false;
  if (!persist) return next;
  try {
    saveFiscalSettings({ language: next });
  } catch (e) {
    console.warn("[fiscal-i18n] setLanguage:", e.message);
  }
  return next;
}

/**
 * Përkthen çelësin sipas gjuhës aktuale.
 */
function t(key) {
  const lang = getCurrentLanguage();
  const table = TRANSLATIONS[lang] || TRANSLATIONS.sq;
  const k = String(key || "");
  if (table[k] != null) return table[k];
  if (TRANSLATIONS.sq[k] != null) return TRANSLATIONS.sq[k];
  return k;
}

function tPayment(method) {
  const key = PAYMENT_KEYS[String(method || "cash").toLowerCase()] || "pay_cash";
  return t(key);
}

function tReceiptType(type) {
  const key = RECEIPT_TYPE_KEYS[String(type || "regular").toLowerCase()] || "type_regular";
  return t(key);
}

/** Krejt fjalori për UI. */
function getTranslations(lang) {
  const L = normalizeLang(lang || getCurrentLanguage());
  return { ...(TRANSLATIONS[L] || TRANSLATIONS.sq) };
}

module.exports = {
  TRANSLATIONS,
  PAYMENT_KEYS,
  RECEIPT_TYPE_KEYS,
  t,
  setLanguage,
  getCurrentLanguage,
  syncLanguageFromSettings,
  tPayment,
  tReceiptType,
  getTranslations,
  normalizeLang,
};
