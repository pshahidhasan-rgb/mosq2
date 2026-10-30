/**
 * Real-Time Khutbah Translation Service
 * Translates Arabic sermon speech into multiple attendee languages
 * Priority 1: DeepL (user's preferred service — fast, high quality)
 * Priority 2: Google Translate GTX & Dict-Chrome (handles all languages: Uzbek, Somali, Urdu, Bengali, etc.)
 * Priority 3: MyMemory Translation API & English Pivot Translation
 * Includes comprehensive normalized dictionary for instantaneous canonical matching
 */

const hasArabicScript = (text) => /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text || '');

// Arabic orthography normalizer: handles hamzas, waslas, dagger alifs, tashkeel, and diacritics
function normalizeArabic(text) {
  if (!text) return '';
  return text
    .replace(/[\u064B-\u065F\u06D6-\u06ED]/g, '') // remove tashkeel/harakat
    .replace(/\u0670/g, 'ا') // dagger alif -> standard alif
    .replace(/[إأآاٱ]/g, 'ا') // normalize all alif variants
    .replace(/ة/g, 'ه') // ta marbuta -> ha
    .replace(/ى/g, 'ي') // alif maqsura -> ya
    .replace(/[^\u0600-\u06FF\s]/g, '') // strip punctuation
    .trim()
    .replace(/\s+/g, ' ');
}

// Canonical sermon dictionary in 10 languages
const SERMON_DICTIONARY = {
  'أعوذ بالله من الشيطان الرجيم': {
    en: 'I seek refuge in Allah from Satan, the accursed.',
    uz: 'La’natlangan shaytondan Allohdan panoh tilayman.',
    tr: 'Kovulmuş şeytandan Allah\'a sığınırım.',
    bn: 'আমি বিতাড়িত শয়তান থেকে আল্লাহর আশ্রয় প্রার্থনা করছি।',
    ur: 'میں شیطان مردود سے اللہ کی پناہ مانگتا ہوں۔',
    fr: 'Je cherche refuge auprès d\'Allah contre Satan le maudit.',
    zh: '我求真主护佑，免遭被驱逐的恶魔的伤害。',
    'zh-TW': '我求真主護佑，免遭被驅逐的惡魔的傷害。',
    id: 'Aku berlindung kepada Allah dari godaan setan yang terkutuk.',
    so: 'Illahay baan ka magan galay shaydaanka la nacladay.'
  },
  'بسم الله الرحمن الرحيم': {
    en: 'In the name of Allah, the Most Gracious, the Most Merciful.',
    uz: 'Mehribon va rahmli Alloh nomi bilan boshlayman.',
    tr: 'Rahman ve Rahim olan Allah\'ın adıyla.',
    bn: 'পরম করুণাময় ও অসীম দয়ালু আল্লাহর নামে।',
    ur: 'اللہ کے نام سے جو بڑا مہربان نہایت رحم والا ہے۔',
    fr: 'Au nom d\'Allah, le Tout Miséricordieux, le Très Miséricordieux.',
    zh: '奉至仁至慈的真主之名。',
    'zh-TW': '奉至仁至慈的真主之名。',
    id: 'Dengan nama Allah Yang Maha Pengasih lagi Maha Penyayang.',
    so: 'Magaca Eebe yaan ku bilaabaynaa, ee Naxariis-guud iyo Naxariis-gaaraba Naxariista.'
  },
  'الحمد لله رب العالمين': {
    en: 'All praise is due to Allah, Lord of the worlds.',
    uz: 'Barcha maqtovlar olamlar Robbi bo\'lgan Allohga xosdir.',
    tr: 'Hamd, âlemlerin Rabbi olan Allah\'a aittir.',
    bn: 'সমস্ত প্রশংসা বিশ্বজগতের প্রতিপালক আল্লাহর জন্য।',
    ur: 'تمام تعریفیں اللہ کے لیے ہیں جو سارے جہانوں کا رب ہے۔',
    fr: 'Louange à Allah, Seigneur de l\'univers.',
    zh: '一切赞颂全归真主，众世界的主。',
    'zh-TW': '一切讚頌全歸真主，眾世界的主。',
    id: 'Segala puji bagi Allah, Rabb semesta alam.',
    so: 'Mahad dhammaanteed Eebaa leh, ee Barbaariyaha uumanka ah.'
  },
  'الحمد لله رب العالمين الرحمن الرحيم مالك يوم الدين': {
    en: 'All praise is due to Allah, Lord of the worlds, the Most Gracious, the Most Merciful, Master of the Day of Judgment.',
    uz: 'Olamlarning Robbi, mehribon va rahmli, qiyomat kunining egasi bo\'lgan Allohga hamdlar bo\'lsin.',
    tr: 'Hamd, âlemlerin Rabbi, Rahman, Rahim ve Din gününün sahibi olan Allah\'a mahsustur.',
    bn: 'সমস্ত প্রশংসা বিশ্বজগতের প্রতিপালক আল্লাহর জন্য, যিনি পরম করুণাময়, অসীম দয়ালু, বিচার দিবসের মালিক।',
    ur: 'سب تعریفیں اللہ کے لیے ہیں جو تمام جہانوں کا پالنے والا ہے، بڑا مہربان نہایت رحم والا ہے، روزِ جزا کا مالک ہے۔',
    fr: 'Louange à Allah, Seigneur de l\'univers, le Tout Miséricordieux, le Très Miséricordieux, Maître du Jour du Jugement.',
    zh: '一切赞颂全归真主，众世界的主，至仁至慈的主，审判日的主。',
    'zh-TW': '一切讚頌全歸真主，眾世界的主，至仁至慈的主，審判日的主。',
    id: 'Segala puji bagi Allah, Rabb semesta alam, Yang Maha Pengasih lagi Maha Penyayang, Pemilik hari pembalasan.',
    so: 'Mahad dhammaanteed Eebaa leh, ee Barbaariyaha uumanka ah, Naxariistaha guud iyo gaarba, Xukunka maalinta abaal-marinta Eebaa leh.'
  },
  'إن الحمد لله نحمده ونستعينه ونستغفره': {
    en: 'All praise is due to Allah; we praise Him, seek His help, and ask for His forgiveness.',
    uz: 'Albatta, barcha maqtovlar Allohga xosdir, Biz Unga hamd aytamiz, Undan yordam va mag‘firat so‘raymiz.',
    tr: 'Hamd yalnızca Allah\'adır; O\'na hamdeder, O\'ndan yardım diler ve O\'ndan bağışlanma dileriz.',
    bn: 'নিশ্চয় সমস্ত প্রশংসা আল্লাহর জন্য, আমরা তাঁরই প্রশংসা করি, তাঁরই কাছে সাহায্য চাই এবং তাঁরই কাছে ক্ষমা প্রার্থনা করি।',
    ur: 'تمام تعریفیں اللہ کے لیے ہیں، ہم اسی کی تعریف کرتے ہیں، اسی سے مدد مانگتے ہیں اور اسی سے بخشش چاہتے ہیں۔',
    fr: 'Toutes les louanges sont à Allah, nous Le louons, nous implorons Son secours et nous Lui demandons pardon.',
    zh: '一切赞颂，全归真主，我们赞美他，求他相助，求他宽恕。',
    'zh-TW': '一切讚頌，全歸真主，我們讚美祂，求祂相助，求祂寬恕。',
    id: 'Segala puji bagi Allah, kami memuji-Nya, memohon pertolongan-Nya, dan memohon ampunan-Nya.',
    so: 'Mahad oo dhan Eebaa leh, waan ku mahadinaynaa, gargaar iyo dambi dhaafna waan weydiisanaynaa.'
  },
  'ونعوذ بالله من شرور أنفسنا ومن سيئات أعمالنا': {
    en: 'And we seek refuge in Allah from the evils of ourselves and from our bad deeds.',
    uz: 'Va o‘z nafsimiz yomonligidan va yomon amallarimizdan Allohdan panoh so‘raymiz.',
    tr: 'Nefislerimizin şerlerinden ve amellerimizin kötülüklerinden Allah\'a sığınırız.',
    bn: 'এবং আমরা আমাদের আত্মার মন্দ থেকে এবং আমাদের খারাপ আমল থেকে আল্লাহর আশ্রয় চাই।',
    ur: 'اور ہم اپنے نفس کے شر اور اپنے برے اعمال سے اللہ کی پناہ مانگتے ہیں۔',
    fr: 'Et nous cherchons refuge auprès d\'Allah contre la méchanceté de nos âmes et les mauvais penchants de nos actions.',
    zh: '我们求真主庇佑，免遭自身之恶和恶行的伤害。',
    'zh-TW': '我們求真主庇佑，免遭自身之惡和惡行的傷害。',
    id: 'Dan kami berlindung kepada Allah dari kejahatan diri kami dan dari keburukan amal perbuatan kami.',
    so: 'Waxaan Eebbe ka magan galeynaa sharka nafteena iyo xumaanta camalkeena.'
  },
  'من يهده الله فلا مضل له، ومن يضلل فلا هادي له': {
    en: 'Whomsoever Allah guides, no one can lead astray, and whomsoever He allows to stray, no one can guide.',
    uz: 'Alloh kimni hidoyat qilsa, uni adashtiruvchi yo‘q, kimni adashtirsa, unga hidoyat qiluvchi yo‘q.',
    tr: 'Allah kime hidayet verirse onu saptıracak yoktur; kimi de saptırırsa ona hidayet verecek yoktur.',
    bn: 'আল্লাহ যাকে পথ দেখান তাকে কেউ পথভ্রষ্ট করতে পারে না, আর যাকে তিনি পথভ্রষ্ট করেন তাকে কেউ পথ দেখাতে পারে না।',
    ur: 'جسے اللہ ہدایت دے اسے کوئی گمراہ نہیں کر سکتا، اور جسے وہ گمراہ کر دے اسے کوئی ہدایت دینے والا نہیں۔',
    fr: 'Celui qu\'Allah guide ne sera jamais égaré, et celui qu\'Il égare ne trouvera aucun guide.',
    zh: '真主引导谁，谁就绝不迷路；真主使谁迷途，谁就绝无引导。',
    'zh-TW': '真主引導誰，誰就絕不迷路；真主使誰迷途，誰就絕無引導。',
    id: 'Barangsiapa yang diberi petunjuk oleh Allah, maka tidak ada yang dapat menyesatkannya, dan barangsiapa yang disesatkan-Nya, maka tidak ada yang dapat memberinya petunjuk.',
    so: 'Qofkii Eebbe hanuuniyo cid baadiyeyn karta ma jirto, qofkii uu baadiyeeyana cid hanuunin karta ma jirto.'
  },
  'وأشهد أن لا إله إلا الله وحده لا شريك له، وأشهد أن محمدا عبده ورسوله': {
    en: 'And I bear witness that there is no god but Allah alone without partner, and I bear witness that Muhammad is His servant and messenger.',
    uz: 'Va guvohlik beramanki, Allohdan o‘zga iloh yo‘q, U yakkadir, sherigi yo‘q; va Muhammad Uning bandasi va elchisidir.',
    tr: 'Ve şehadet ederim ki Allah\'tan başka ilah yoktur, O tektir, ortağı yoktur; ve yine şehadet ederim ki Muhammed O\'nun kulu ve elçisidir.',
    bn: 'এবং আমি সাক্ষ্য দিচ্ছি যে, এক আল্লাহ ব্যতীত কোন সত্য উপাস্য নেই, তাঁর কোন অংশীদার নেই, এবং মুহাম্মদ তাঁর বান্দা ও রাসূল।',
    ur: 'اور میں گواہی دیتا ہوں کہ اللہ کے سوا کوئی معبود نہیں وہ اکیلا ہے، اور محمد اس کے بندے اور رسول ہیں۔',
    fr: 'Et j\'atteste qu\'il n\'y a de divinité digne d\'adoration qu\'Allah, Seul sans associé, et que Muhammad est Son serviteur et Son messager.',
    zh: '我见证万物非主，唯有真主，独一无偶；我又见证穆罕默德是他的仆人和使者。',
    'zh-TW': '我見證萬物非主，唯有真主，獨一無偶；我又見證穆罕默德是祂的僕人和使者。',
    id: 'Dan aku bersaksi bahwa tidak ada sesembahan yang berhak disembah selain Allah semata, tidak ada sekutu bagi-Nya, dan aku bersaksi bahwa Muhammad adalah hamba dan utusan-Nya.',
    so: 'Waxaan qirayaa inaan Ilaah kale jirin Eebbe mooyee, kaligiisna yahay oon shariik lahayn, waxaana qirayaa in Muxammad yahay addoonkiisii iyo rasuulkiisii.'
  },
  'أيها الإخوة الكرام، اتقوا الله تعالى واعلموا أن الحياة الدنيا دار امتحان': {
    en: 'Respected brothers, fear Allah the Almighty, and know that this worldly life is a realm of trial.',
    uz: 'Ey aziz birodarlar! Alloh taolodan qo‘rqing va bilingki, bu dunyo hayoti bir imtihan maskanidir.',
    tr: 'Ey aziz kardeşler! Yüce Allah\'tan sakının ve bilin ki bu dünya hayatı bir imtihan yurdudur.',
    bn: 'হে সম্মানিত ভাইয়েরা, সর্বশক্তিমান আল্লাহকে ভয় করুন এবং জেনে রাখুন যে এই পার্থিব জীবন একটি পরীক্ষার স্থান।',
    ur: 'معزز بھائیو! اللہ تعالیٰ کا تقویٰ اختیار کرو اور جان لو کہ یہ دنیا امتحان کا گھر ہے۔',
    fr: 'Chers frères, craignez Allah le Très-Haut et sachez que la vie d\'ici-bas est une épreuve.',
    zh: '尊贵的兄弟们，应当敬畏至尊的真主，并当知道今世是考验的场所。',
    'zh-TW': '尊貴的兄弟們，應當敬畏至尊的真主，並當知道今世是考驗的場所。',
    id: 'Wahai kaum mukminin yang terhormat, bertakwalah kepada Allah Ta\'ala dan ketahuilah bahwa kehidupan dunia ini adalah tempat ujian.',
    so: 'Walaalayaal sharaf leh, ka cabsada Eebbe weyne oo ogaada in noloshan adduunku tahay guri imtixaan.'
  },
  'وإن الصبر على الطاعة وعن المعصية مفتاح الفرج والرضا': {
    en: 'Indeed, patience in obedience and restraint from sin are the keys to relief and contentment.',
    uz: 'Albatta, toatda sabr qilish va gunohlardan tiyilish najot va rizolik kalitidir.',
    tr: 'Şüphesiz itaatte sabır ve günahtan kaçınmak, kurtuluş ve rızanın anahtarıdır.',
    bn: 'নিশ্চয়ই আনুগত্যের ক্ষেত্রে ধৈর্য এবং পাপ থেকে বিরত থাকা হলো স্বস্তি ও সন্তুষ্টির মূল চাবিকাঠি।',
    ur: 'یقیناً اطاعت پر صبر اور گناہ سے رکنا ہی کشادگی اور خوشنودی کی چابی ہے۔',
    fr: 'Certes, la patience dans l\'obéissance et l\'abstinence du péché sont la clé du soulagement et du contentement.',
    zh: '确切地，服从中的坚忍与摒弃罪恶，是得解脱与喜悦的关键。',
    'zh-TW': '確切地，服從中的堅忍與摒棄罪惡，是得解脫與喜悅的關鍵。',
    id: 'Sesungguhnya sabar dalam ketaatan dan menahan diri dari kemaksiatan adalah kunci jalan keluar dan keridhaan.',
    so: 'Sabirka addeecidda iyo ka fogaanshaha dambiga waa furaha farajka iyo raallinimada.'
  },
  'فاستغفروا الله يغفر لكم، إنه هو الغفور الرحيم': {
    en: 'So seek forgiveness from Allah, He will forgive you; indeed, He is the Forgiving, the Merciful.',
    uz: 'Bas, Allohdan mag‘firat so‘rang, U sizlarni kechiradi; albatta, U kechiruvchi va mehribondir.',
    tr: 'Öyleyse Allah\'tan bağışlanma dileyin ki sizi bağışlasın; şüphesiz O, çok bağışlayan ve çok merhamet edendir.',
    bn: 'সুতরাং তোমরা আল্লাহর কাছে ক্ষমা প্রার্থনা কর, তিনি তোমাদের ক্ষমা করবেন; নিশ্চয় তিনি পরম ক্ষমাশীল, পরম দয়ালু।',
    ur: 'پس تم اللہ سے مغفرت طلب کرو وہ تمہیں معاف فرما دے گا، بیشک وہی معاف فرمانے والا، نہایت رحم کرنے والا ہے۔',
    fr: 'Demandez donc pardon à Allah, Il vous pardonnera; car Il est le Pardonneur, le Très Miséricordieux.',
    zh: '你们当向真主求饶，他必饶恕你们；他确是至赦的，至慈的。',
    'zh-TW': '你們當向真主求饒，祂必饒恕你們；祂確是至赦的，至慈的。',
    id: 'Maka mohonlah ampunan kepada Allah, niscaya Dia akan mengampuni kalian; sungguh Dia Maha Pengampun lagi Maha Penyayang.',
    so: 'Eebbe dambi dhaaf weydiista wuu idiin dambi dhaafi doonaaye, Eebbaa dambi dhaafe iyo naxariiste ah.'
  },
  'اللهم اغفر للمسلمين والمسلمات، الأحياء منهم والأموات': {
    en: 'O Allah, forgive all Muslim men and women, those who are living and those who have passed away.',
    uz: 'Yo Alloh, barcha musulmon erkak va ayollarni, ularning tiriklari va vafot etganlarini mag‘firat qil.',
    tr: 'Allah\'ım! Mümin erkekleri ve mümin kadınları, yaşayanlarını ve vefat etmiş olanlarını bağışla.',
    bn: 'হে আল্লাহ, সকল মুসলিম নর-নারীকে ক্ষমা করে দিন, তাদের জীবিত ও মৃত সবাইকে।',
    ur: 'اے اللہ! تمام مسلمان مردوں اور عورتوں کو معاف فرما، ان میں سے جو زندہ ہیں اور جو وفات پا چکے ہیں۔',
    fr: 'Ô Allah, pardonne aux croyants et aux croyantes, vivants comme morts.',
    zh: '主啊！求你宽恕所有穆斯林男女，无论生者还是亡人。',
    'zh-TW': '主啊！求祢寬恕所有穆斯林男女，無論生者還是亡人。',
    id: 'Ya Allah, ampunilah seluruh kaum muslimin dan muslimat, yang masih hidup di antara mereka maupun yang telah wafat.',
    so: 'Eebbow u dambi dhaaf dhammaan muslimiinta rag iyo dumarba, kuwa nool iyo kuwa dhintayba.'
  },
  'السلام عليكم ورحمة الله وبركاته': {
    en: 'May the peace, mercy, and blessings of Allah be upon you.',
    uz: 'Sizlarga Allohning tinchligi, rahmati va barakoti bo‘lsin.',
    tr: 'Allah\'ın selâmı, rahmeti ve bereketi üzerinize olsun.',
    bn: 'আপনাদের উপর আল্লাহর শান্তি, রহমত ও বরকত বর্ষিত হোক।',
    ur: 'آپ پر اللہ کی سلامتی، رحمت اور برکتیں نازل ہوں۔',
    fr: 'Que la paix, la miséricorde et les bénédictions d\'Allah soient sur vous.',
    zh: '祈求真主的平安、慈悯和吉庆降临你们。',
    'zh-TW': '祈求真主的平安、慈憫和吉慶降臨你們。',
    id: 'Semoga keselamatan, rahmat Allah, dan keberkahan-Nya tercurah kepada kalian.',
    so: 'Nabadgelyo, naxariis iyo barako Eebbe dushiina ha ahaato.'
  }
};

// Pre-compute normalized lookup entries for instant canonical matching
const NORMALIZED_DICTIONARY_ENTRIES = Object.entries(SERMON_DICTIONARY).map(([origKey, transMap]) => ({
  normKey: normalizeArabic(origKey),
  transMap
}));

const LANGUAGE_NAMES = {
  en: 'English',
  uz: 'Uzbek',
  tr: 'Turkish',
  ur: 'Urdu',
  bn: 'Bengali',
  fr: 'French',
  zh: 'Chinese Mandarin (Simplified)',
  'zh-TW': 'Traditional Chinese',
  id: 'Indonesian',
  so: 'Somali'
};

async function fetchWithTimeout(url, opts = {}, timeoutMs = 4500) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

class TranslationService {
  constructor(apiKey, deeplKey, model) {
    const isPlaceholder = (k) => !k || k.includes('your_') || k.includes('placeholder') || k.trim() === '';
    const key = apiKey || process.env.OPENROUTER_API_KEY || process.env.GROQ_API_KEY;
    this.openrouterKey = isPlaceholder(key) ? '' : key;
    this.model = model || process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct';
    this.deeplKey = isPlaceholder(deeplKey || process.env.DEEPL_API_KEY) ? '' : (deeplKey || process.env.DEEPL_API_KEY);
    this.cache = new Map();
  }

  /**
   * Helper: Google Translate GTX endpoint
   */
  async _fetchGoogleGtx(text, targetLang, sourceLang = 'auto') {
    let tl = targetLang;
    if (tl === 'zh' || tl === 'zh-CN') tl = 'zh-CN';
    if (tl === 'zh-TW') tl = 'zh-TW';
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sourceLang}&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetchWithTimeout(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' }
    }, 4000);
    if (!res.ok) throw new Error(`GTX returned status ${res.status}`);
    const data = await res.json();
    const translated = data[0]?.map(item => item[0]).join('').trim();
    if (!translated) throw new Error('GTX empty response');
    return translated;
  }

  /**
   * Helper: Google Translate Clients5 Dict-Chrome endpoint
   */
  async _fetchGoogleClients5(text, targetLang, sourceLang = 'auto') {
    let tl = targetLang;
    if (tl === 'zh' || tl === 'zh-CN') tl = 'zh';
    if (tl === 'zh-TW') tl = 'zh-TW';
    const url = `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=${sourceLang}&tl=${encodeURIComponent(tl)}&q=${encodeURIComponent(text)}`;
    const res = await fetchWithTimeout(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' }
    }, 4000);
    if (!res.ok) throw new Error(`Clients5 returned status ${res.status}`);
    const data = await res.json();
    const translated = Array.isArray(data) ? (Array.isArray(data[0]) ? data[0][0] : data[0]) : null;
    if (!translated || typeof translated !== 'string') throw new Error('Clients5 invalid response');
    return translated.trim();
  }

  /**
   * Helper: MyMemory Translation API
   */
  async _fetchMyMemory(text, targetLang, sourceLang = 'ar') {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${sourceLang}|${encodeURIComponent(targetLang)}`;
    const res = await fetchWithTimeout(url, {}, 4000);
    if (!res.ok) throw new Error(`MyMemory returned status ${res.status}`);
    const data = await res.json();
    const translated = data.responseData?.translatedText;
    if (!translated || translated.includes('MYMEMORY WARNING')) throw new Error('MyMemory invalid result');
    return translated.replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
  }

  /**
   * Check if a translated text is valid for the target language.
   * Uzbek, Somali, English, Turkish, French, etc. must NEVER be raw Arabic.
   */
  _isValidTranslation(text, targetLang) {
    if (!text || typeof text !== 'string' || !text.trim()) return false;
    const clean = text.trim();
    if (clean.startsWith(`[${targetLang.toUpperCase()}]`)) return false;
    if (targetLang !== 'ar' && targetLang !== 'ur' && hasArabicScript(clean)) return false;
    return true;
  }

  /**
   * Translates Arabic text into multiple target languages
   * Prioritizes English so subsequent non-Soniox languages have an English pivot available
   * Concurrency-controlled to avoid 429 rate limits
   */
  async translateMultiple(arabicText, targetLanguages = ['en', 'uz', 'bn', 'ur', 'fr', 'zh', 'tr']) {
    if (!arabicText || arabicText.trim().length === 0) return {};

    const results = {};
    const knownTranslations = {};

    // Step 1: Always translate English first (used for English attendee and as canonical pivot)
    if (targetLanguages.includes('en')) {
      try {
        const enText = await this.translate(arabicText, 'en');
        if (this._isValidTranslation(enText, 'en')) {
          results.en = enText;
          knownTranslations.en = enText;
        }
      } catch (err) {
        console.warn('[Translation] English translation error:', err.message);
      }
    }

    // Step 2: Translate remaining languages in batches of 3 to avoid socket saturation
    const remainingLangs = targetLanguages.filter(l => l !== 'en');
    const BATCH_SIZE = 3;
    for (let i = 0; i < remainingLangs.length; i += BATCH_SIZE) {
      const batch = remainingLangs.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (lang) => {
        try {
          const trans = await this.translate(arabicText, lang, knownTranslations);
          if (this._isValidTranslation(trans, lang)) {
            results[lang] = trans;
            knownTranslations[lang] = trans;
          } else if (knownTranslations.en && lang !== 'ar' && lang !== 'ur') {
            // Safe fallback: readable English rather than empty or raw Arabic
            results[lang] = knownTranslations.en;
          } else {
            results[lang] = '';
          }
        } catch (err) {
          console.warn(`[Translation] Error translating to ${lang}:`, err.message);
          results[lang] = knownTranslations.en || '';
        }
      }));
    }

    return results;
  }

  /**
   * Translates Arabic text to a single target language with multi-tier failover
   */
  async translate(arabicText, targetLang = 'en', knownTranslations = {}) {
    if (!arabicText) return '';
    const cleanText = arabicText.trim();
    const cacheKey = `${cleanText}:${targetLang}`;

    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      if (this._isValidTranslation(cached, targetLang)) {
        return cached;
      }
      this.cache.delete(cacheKey);
    }

    // Check predefined sermon dictionary with Arabic orthography normalization (0ms canonical match)
    const normalizedInput = normalizeArabic(cleanText);
    for (const { normKey, transMap } of NORMALIZED_DICTIONARY_ENTRIES) {
      if (normalizedInput.includes(normKey) || normKey.includes(normalizedInput)) {
        if (transMap[targetLang]) {
          const canonical = transMap[targetLang];
          this.cache.set(cacheKey, canonical);
          return canonical;
        }
      }
    }

    // Priority 1: DeepL (for supported languages: en, fr, zh, zh-TW, tr)
    const deeplSupportedNatively = ['en', 'fr', 'zh', 'zh-TW', 'tr'];
    const deeplLangMap = { en: 'EN-US', fr: 'FR', zh: 'ZH', 'zh-TW': 'ZH', tr: 'TR' };

    if (this.deeplKey && deeplSupportedNatively.includes(targetLang)) {
      try {
        const target = deeplLangMap[targetLang];
        const res = await fetchWithTimeout('https://api-free.deepl.com/v2/translate', {
          method: 'POST',
          headers: {
            'Authorization': `DeepL-Auth-Key ${this.deeplKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            text: [cleanText],
            target_lang: target,
            source_lang: 'AR'
          })
        }, 4000);

        if (res.ok) {
          const data = await res.json();
          const translated = data.translations?.[0]?.text;
          if (this._isValidTranslation(translated, targetLang)) {
            this.cache.set(cacheKey, translated);
            return translated;
          }
        }
      } catch (err) {
        // DeepL failed or timed out, seamlessly proceed to dynamic engines
      }
    }

    // Priority 2: Google Translate GTX (primary dynamic neural engine for all languages including Uzbek & Somali)
    try {
      const trans = await this._fetchGoogleGtx(cleanText, targetLang, 'auto');
      if (this._isValidTranslation(trans, targetLang)) {
        this.cache.set(cacheKey, trans);
        return trans;
      }
    } catch (_) {}

    // Priority 3: Google Clients5 Dict-Chrome endpoint
    try {
      const trans = await this._fetchGoogleClients5(cleanText, targetLang, 'auto');
      if (this._isValidTranslation(trans, targetLang)) {
        this.cache.set(cacheKey, trans);
        return trans;
      }
    } catch (_) {}

    // Priority 4: MyMemory Translation API
    try {
      const trans = await this._fetchMyMemory(cleanText, targetLang, 'ar');
      if (this._isValidTranslation(trans, targetLang)) {
        this.cache.set(cacheKey, trans);
        return trans;
      }
    } catch (_) {}

    // Priority 5: Two-Step English Pivot Translation
    // Translating English -> Uzbek / Somali / Urdu is extremely reliable across all translation backends
    if (targetLang !== 'en') {
      try {
        let pivotSource = knownTranslations.en;
        if (!pivotSource) {
          pivotSource = await this.translate(cleanText, 'en');
        }

        if (pivotSource && !hasArabicScript(pivotSource)) {
          // Translate English -> targetLang
          try {
            const pivotTrans = await this._fetchGoogleGtx(pivotSource, targetLang, 'en');
            if (this._isValidTranslation(pivotTrans, targetLang)) {
              this.cache.set(cacheKey, pivotTrans);
              return pivotTrans;
            }
          } catch (_) {}

          try {
            const pivotTrans = await this._fetchGoogleClients5(pivotSource, targetLang, 'en');
            if (this._isValidTranslation(pivotTrans, targetLang)) {
              this.cache.set(cacheKey, pivotTrans);
              return pivotTrans;
            }
          } catch (_) {}

          try {
            const pivotTrans = await this._fetchMyMemory(pivotSource, targetLang, 'en');
            if (this._isValidTranslation(pivotTrans, targetLang)) {
              this.cache.set(cacheKey, pivotTrans);
              return pivotTrans;
            }
          } catch (_) {}
        }
      } catch (_) {}
    }

    // Safe fallback: NEVER return raw Arabic prefixed with [UZ] or [SO]!
    // Return English translation if available, or cleanText only if target is Arabic
    if (knownTranslations.en && targetLang !== 'ar' && targetLang !== 'ur') {
      return knownTranslations.en;
    }

    if (targetLang === 'ar') {
      return cleanText;
    }

    return '';
  }
}

module.exports = {
  TranslationService,
  SERMON_DICTIONARY,
  LANGUAGE_NAMES,
  normalizeArabic,
  hasArabicScript
};
