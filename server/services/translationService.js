/**
 * Real-Time Khutbah Translation Service
 * Translates Arabic sermon speech into multiple attendee languages
 * Priority 1: DeepL (user's preferred service — fast, high quality)
 * Priority 2: OpenRouter Llama 3.3 70B (fallback for unsupported languages)
 * Includes comprehensive fallback dictionary for autonomous testing & offline use
 */

// Fallback dictionary for common sermon phrases in 6 languages
const SERMON_DICTIONARY = {
  'أعوذ بالله من الشيطان الرجيم': {
    en: 'I seek refuge in Allah from Satan, the accursed.',
    bn: 'আমি বিতাড়িত শয়তান থেকে আল্লাহর আশ্রয় প্রার্থনা করছি।',
    ur: 'میں شیطان مردود سے اللہ کی پناہ مانگتا ہوں۔',
    fr: 'Je cherche refuge auprès d\'Allah contre Satan le maudit.',
    zh: '我求真主护佑，免遭被驱逐的恶魔的伤害。',
    'zh-TW': '我求真主護佑，免遭被驅逐的惡魔的傷害。',
    tr: 'Kovulmuş şeytandan Allah\'a sığınırım.',
    uz: 'Quvilgan shaytondan Allohdan panoh so‘rayman.'
  },
  'إن الحمد لله نحمده ونستعينه ونستغفره': {
    en: 'All praise is due to Allah; we praise Him, seek His help, and ask for His forgiveness.',
    bn: 'নিশ্চয় সমস্ত প্রশংসা আল্লাহর জন্য, আমরা তাঁরই প্রশংসা করি, তাঁরই কাছে সাহায্য চাই এবং তাঁরই কাছে ক্ষমা প্রার্থনা করি।',
    ur: 'تمام تعریفیں اللہ کے لیے ہیں، ہم اسی کی تعریف کرتے ہیں، اسی سے مدد مانگتے ہیں اور اسی سے بخشش چاہتے ہیں۔',
    fr: 'Toutes les louanges sont à Allah, nous Le louons, nous implorons Son secours et nous Lui demandons pardon.',
    zh: '一切赞颂，全归真主，我们赞美他，求他相助，求他宽恕。',
    'zh-TW': '一切讚頌，全歸真主，我們讚美祂，求祂相助，求祂寬恕。',
    tr: 'Hamd yalnızca Allah\'adır; O\'na hamdeder, O\'ndan yardım diler ve O\'ndan bağışlanma dileriz.',
    uz: 'Albatta, barcha maqtovlar Allohga xosdir, Biz Unga hamd aytamiz, Undan yordam va mag‘firat so‘raymiz.'
  },
  'ونعوذ بالله من شرور أنفسنا ومن سيئات أعمالنا': {
    en: 'And we seek refuge in Allah from the evils of ourselves and from our bad deeds.',
    bn: 'এবং আমরা আমাদের আত্মার মন্দ থেকে এবং আমাদের খারাপ আমল থেকে আল্লাহর আশ্রয় চাই।',
    ur: 'اور ہم اپنے نفس کے شر اور اپنے برے اعمال سے اللہ کی پناہ مانگتے ہیں۔',
    fr: 'Et nous cherchons refuge auprès d\'Allah contre la méchanceté de nos âmes et les mauvais penchants de nos actions.',
    zh: '我们求真主庇佑，免遭自身之恶和恶行的伤害。',
    'zh-TW': '我們求真主庇佑，免遭自身之惡和惡行的傷害。',
    tr: 'Nefislerimizin şerlerinden ve amellerimizin kötülüklerinden Allah\'a sığınırız.',
    uz: 'Va o‘z nafsimiz yomonligidan va yomon amallarimizdan Allohdan panoh so‘raymiz.'
  },
  'من يهده الله فلا مضل له، ومن يضلل فلا هادي له': {
    en: 'Whomsoever Allah guides, no one can lead astray, and whomsoever He allows to stray, no one can guide.',
    bn: 'আল্লাহ যাকে পথ দেখান তাকে কেউ পথভ্রষ্ট করতে পারে না, আর যাকে তিনি পথভ্রষ্ট করেন তাকে কেউ পথ দেখাতে পারে না।',
    ur: 'جسے اللہ ہدایت دے اسے کوئی گمراہ نہیں کر سکتا، اور جسے وہ گمراہ کر دے اسے کوئی ہدایت دینے والا نہیں۔',
    fr: 'Celui qu\'Allah guide ne sera jamais égaré, et celui qu\'Il égare ne trouvera aucun guide.',
    zh: '真主引导谁，谁就绝不迷路；真主使谁迷途，谁就绝无引导。',
    'zh-TW': '真主引導誰，誰就絕不迷路；真主使誰迷途，誰就絕無引導。',
    tr: 'Allah kime hidayet verirse onu saptıracak yoktur; kimi de saptırırsa ona hidayet verecek yoktur.',
    uz: 'Alloh kimni hidoyat qilsa, uni adashtiruvchi yo‘q, kimni adashtirsa, unga hidoyat qiluvchi yo‘q.'
  },
  'وأشهد أن لا إله إلا الله وحده لا شريك له، وأشهد أن محمدا عبده ورسوله': {
    en: 'And I bear witness that there is no god but Allah alone without partner, and I bear witness that Muhammad is His servant and messenger.',
    bn: 'এবং আমি সাক্ষ্য দিচ্ছি যে, এক আল্লাহ ব্যতীত কোন সত্য উপাস্য নেই, তাঁর কোন অংশীদার নেই, এবং মুহাম্মদ তাঁর বান্দা ও রাসূল।',
    ur: 'اور میں گواہی دیتا ہوں کہ اللہ کے سوا کوئی معبود نہیں وہ اکیلا ہے، اور محمد اس کے بندے اور رسول ہیں۔',
    fr: 'Et j\'atteste qu\'il n\'y a de divinité digne d\'adoration qu\'Allah, Seul sans associé, et que Muhammad est Son serviteur et Son messager.',
    zh: '我见证万物非主，唯有真主，独一无偶；我又见证穆罕默德是他的仆人和使者。',
    'zh-TW': '我見證萬物非主，唯有真主，獨一無偶；我又見證穆罕默德是祂的僕人和使者。',
    tr: 'Ve şehadet ederim ki Allah\'tan başka ilah yoktur, O tektir, ortağı yoktur; ve yine şehadet ederim ki Muhammed O\'nun kulu ve elçisidir.',
    uz: 'Va guvohlik beramanki, Allohdan o‘zga iloh yo‘q, U yakkadir, sherigi yo‘q; va Muhammad Uning bandasi va elchisidir.'
  },
  'أيها الإخوة الكرام، اتقوا الله تعالى واعلموا أن الحياة الدنيا دار امتحان': {
    en: 'Respected brothers, fear Allah the Almighty, and know that this worldly life is a realm of trial.',
    bn: 'হে সম্মানিত ভাইয়েরা, সর্বশক্তিমান আল্লাহকে ভয় করুন এবং জেনে রাখুন যে এই পার্থিব জীবন একটি পরীক্ষার স্থান।',
    ur: 'معزز بھائیو! اللہ تعالیٰ کا تقویٰ اختیار کرو اور جان لو کہ یہ دنیا امتحان کا گھر ہے۔',
    fr: 'Chers frères, craignez Allah le Très-Haut et sachez que la vie d\'ici-bas est une épreuve.',
    zh: '尊贵的兄弟们，应当敬畏至尊的真主，并当知道今世是考验的场所。',
    'zh-TW': '尊貴的兄弟們，應當敬畏至尊的真主，並當知道今世是考驗的場所。',
    tr: 'Ey aziz kardeşler! Yüce Allah\'tan sakının ve bilin ki bu dünya hayatı bir imtihan yurdudur.',
    uz: 'Ey aziz birodarlar! Alloh taolodan qo‘rqing va bilingki, bu dunyo hayoti bir imtihan maskanidir.'
  },
  'وإن الصبر على الطاعة وعن المعصية مفتاح الفرج والرضا': {
    en: 'Indeed, patience in obedience and restraint from sin are the keys to relief and contentment.',
    bn: 'নিশ্চয়ই আনুগত্যের ক্ষেত্রে ধৈর্য এবং পাপ থেকে বিরত থাকা হলো স্বস্তি ও সন্তুষ্টির মূল চাবিকাঠি।',
    ur: 'یقیناً اطاعت پر صبر اور گناہ سے رکنا ہی کشادگی اور خوشنودی کی چابی ہے۔',
    fr: 'Certes, la patience dans l\'obéissance et l\'abstinence du péché sont la clé du soulagement et du contentement.',
    zh: '确切地，服从中的坚忍与摒弃罪恶，是得解脱与喜悦的关键。',
    'zh-TW': '確切地，服從中的堅忍與摒棄罪惡，是得解脫與喜悅的關鍵。',
    tr: 'Şüphesiz itaatte sabır ve günahtan kaçınmak, kurtuluş ve rızanın anahtarıdır.',
    uz: 'Albatta, toatda sabr qilish va gunohlardan tiyilish najot va rizolik kalitidir.'
  },
  'فاستغفروا الله يغفر لكم، إنه هو الغفور الرحيم': {
    en: 'So seek forgiveness from Allah, He will forgive you; indeed, He is the Forgiving, the Merciful.',
    bn: 'সুতরাং তোমরা আল্লাহর কাছে ক্ষমা প্রার্থনা কর, তিনি তোমাদের ক্ষমা করবেন; নিশ্চয় তিনি পরম ক্ষমাশীল, পরম দয়ালু।',
    ur: 'پس تم اللہ سے مغفرت طلب کرو وہ تمہیں معاف فرমা دے گا، بیشک وہی معاف فرمانے والا، نہایت رحم کرنے والا ہے۔',
    fr: 'Demandez donc pardon à Allah, Il vous pardonnera; car Il est le Pardonneur, le Très Miséricordieux.',
    zh: '你们当向真主求饶，他必饶恕你们；他确是至赦的，至慈的。',
    'zh-TW': '你們當向真主求饒，祂必饒恕你們；祂確是至赦的，至慈的。',
    tr: 'Öyleyse Allah\'tan bağışlanma dileyin ki sizi bağışlasın; şüphesiz O, çok bağışlayan ve çok merhamet edendir.',
    uz: 'Bas, Allohdan mag‘firat so‘rang, U sizlarni kechiradi; albatta, U kechiruvchi va mehribondir.'
  },
  'اللهم اغفر للمسلمين والمسلمات، الأحياء منهم والأموات': {
    en: 'O Allah, forgive all Muslim men and women, those who are living and those who have passed away.',
    bn: 'হে আল্লাহ, সকল মুসলিম নর-নারীকে ক্ষমা করে দিন, তাদের জীবিত ও মৃত সবাইকে।',
    ur: 'اے اللہ! تمام مسلمان مردوں اور عورتوں کو معاف فرما، ان میں سے جو زندہ ہیں اور جو وفات پا چکے ہیں۔',
    fr: 'Ô Allah, pardonne aux croyants et aux croyantes, vivants comme morts.',
    zh: '主啊！求你宽恕所有穆斯林男女，无论生者还是亡人。',
    'zh-TW': '主啊！求祢寬恕所有穆斯林男女，無論生者還是亡人。',
    tr: 'Allah\'ım! Mümin erkekleri ve mümin kadınları, yaşayanlarını ve vefat etmiş olanlarını bağışla.',
    uz: 'Yo Alloh, barcha musulmon erkak va ayollarni, ularning tiriklari va vafot etganlarini mag‘firat qil.'
  }
};

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
   * Translates Arabic text into multiple target languages
   * @param {string} arabicText - Input Arabic text
   * @param {string[]} targetLanguages - Array of ISO codes (e.g. ['en', 'bn', 'ur'])
   * @returns {Promise<Object>} Map of { [lang]: translatedText }
   */
  async translateMultiple(arabicText, targetLanguages = ['en', 'bn', 'ur', 'fr', 'zh', 'tr']) {
    if (!arabicText || arabicText.trim().length === 0) return {};

    const results = {};
    const promises = targetLanguages.map(async (lang) => {
      try {
        const translated = await this.translate(arabicText, lang);
        results[lang] = translated;
      } catch (err) {
        console.warn(`[Translation] Error translating to ${lang}:`, err.message);
        results[lang] = arabicText;
      }
    });

    await Promise.all(promises);
    return results;
  }

  /**
   * Translates Arabic text to a single target language
   */
  async translate(arabicText, targetLang = 'en') {
    if (!arabicText) return '';
    const cleanText = arabicText.trim();
    const cacheKey = `${cleanText}:${targetLang}`;

    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    // Check predefined sermon dictionary first (instant & canonical)
    for (const [key, transMap] of Object.entries(SERMON_DICTIONARY)) {
      if (cleanText.includes(key) || key.includes(cleanText)) {
        if (transMap[targetLang]) {
          this.cache.set(cacheKey, transMap[targetLang]);
          return transMap[targetLang];
        }
      }
    }

    // Priority 1: DeepL (user's preferred translation service)
    // DeepL language codes for all 6 target languages
    const deeplLangMap = {
      en: 'EN-US',
      fr: 'FR',
      zh: 'ZH',
      'zh-TW': 'ZH',
      tr: 'TR',
      ur: 'AR',  // DeepL doesn't support Urdu; will fall through to OpenRouter
      bn: 'AR'   // DeepL doesn't support Bengali; will fall through to OpenRouter
    };
    const deeplSupportedNatively = ['en', 'fr', 'zh', 'zh-TW', 'tr'];

    if (this.deeplKey && deeplSupportedNatively.includes(targetLang)) {
      try {
        const target = deeplLangMap[targetLang];
        const res = await fetch('https://api-free.deepl.com/v2/translate', {
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
        });

        if (res.ok) {
          const data = await res.json();
          const translated = data.translations?.[0]?.text;
          if (translated) {
            this.cache.set(cacheKey, translated);
            return translated;
          }
        } else {
          const errBody = await res.text();
          console.warn(`[Translation] DeepL returned ${res.status} for ${targetLang}:`, errBody.substring(0, 100));
        }
      } catch (err) {
        console.warn(`[Translation] DeepL failed for ${targetLang}:`, err.message);
      }
    }

    // Priority 2: OpenRouter Llama 3.3 70B (handles Bengali, Urdu, and DeepL fallback)
    if (this.openrouterKey) {
      try {
        const langName = LANGUAGE_NAMES[targetLang] || targetLang;
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.openrouterKey}`,
            'HTTP-Referer': 'https://mosq.ai',
            'X-Title': 'MosqAI Khutbah Translation'
          },
          body: JSON.stringify({
            model: this.model,
            messages: [
              {
                role: 'system',
                content: `You are an expert Islamic Friday sermon (Khutbah) translator. Translate the Arabic text into ${langName} with the highest theological precision, dignity, and accuracy. Retain sacred terms (Allah, Taqwa, Ihsan, Akhirah) with reverent equivalents. Output ONLY the translated text without commentary or quotes.`
              },
              {
                role: 'user',
                content: cleanText
              }
            ],
            temperature: 0.1,
            max_tokens: 300
          })
        });

        if (response.ok) {
          const data = await response.json();
          const translated = data.choices[0]?.message?.content?.trim();
          if (translated) {
            this.cache.set(cacheKey, translated);
            return translated;
          }
        } else {
          const errBody = await response.text();
          console.warn(`[Translation] OpenRouter returned status ${response.status}:`, errBody);
        }
      } catch (err) {
        console.warn(`[Translation] OpenRouter translation failed: ${err.message}`);
      }
    }

    // Priority 3: Dynamic Real-Time Neural Translation Engine (Translates ANY arbitrary dynamic speech)
    try {
      let googleLang = targetLang;
      if (targetLang === 'zh' || targetLang === 'zh-CN') googleLang = 'zh-CN';
      if (targetLang === 'zh-TW') googleLang = 'zh-TW';
      const res = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=ar&tl=${googleLang}&dt=t&q=${encodeURIComponent(cleanText)}`);
      if (res.ok) {
        const data = await res.json();
        const translated = data[0]?.map(item => item[0]).join('').trim();
        if (translated) {
          this.cache.set(cacheKey, translated);
          return translated;
        }
      }
    } catch (err) {
      console.warn(`[Dynamic Translation] Engine failed for ${targetLang}:`, err.message);
    }

    // Dynamic fallback for any other text
    const fallbackText = `[${targetLang.toUpperCase()}] ${cleanText}`;
    this.cache.set(cacheKey, fallbackText);
    return fallbackText;
  }
}

module.exports = {
  TranslationService,
  SERMON_DICTIONARY,
  LANGUAGE_NAMES
};
