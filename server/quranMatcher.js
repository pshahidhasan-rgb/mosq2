/**
 * Quran Ayah Matcher
 * Real-time detection of Quranic recitation in Arabic speech stream
 * Matches spoken Arabic against Quranic verses with normalized fuzzy search
 */

function normalizeArabic(text) {
  if (!text) return '';
  return text
    // Remove diacritics / tashkeel / harakat
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '')
    // Remove tatweel / kashida
    .replace(/\u0640/g, '')
    // Normalize alefs (إ, أ, آ, ٱ -> ا)
    .replace(/[إأآٱ]/g, 'ا')
    // Normalize taa marbuta (ة -> ه)
    .replace(/ة/g, 'ه')
    // Normalize alif maqsurah (ى -> ي)
    .replace(/ى/g, 'ي')
    // Normalize punctuation and whitespace
    .replace(/[.,/#!$%^&*;:{}=\-_`~()؟،«»"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Canonical dataset of frequently recited Khutbah & Prayer verses
const QURAN_VERSES = [
  // Khutbatul Haajah verses (Recited at the start of every Friday Khutbah)
  {
    surahNumber: 3,
    surahNameArabic: 'آل عمران',
    surahNameEnglish: "Ali 'Imran",
    ayahNumber: 102,
    arabicUthmani: 'يَا أَيُّهَا الَّذِينَ آمَنُوا اتَّقُوا اللَّهَ حَقَّ تُقَاتِهِ وَلَا تَمُوتُنَّ إِلَّا وَأَنتُم مُّسْلِمُونَ',
    translations: {
      en: 'O you who have believed, fear Allah as He should be feared and do not die except as Muslims [in submission to Him].',
      bn: 'হে মুমিনগণ! তোমরা আল্লাহকে ভয় কর যেভাবে ভয় করা উচিত, এবং আত্মসমর্পণকারী (মুসলিম) না হয়ে কিছুতেই মৃত্যুবরণ করো না।',
      ur: 'اے ایمان والو! اللہ سے ڈرو جیسا کہ اس سے ڈرنے کا حق ہے، اور تمہیں موت نہ آئے مگر اس حال میں کہ تم مسلم ہو۔',
      fr: 'Ô les croyants! Craignez Allah comme Il doit être craint. Et ne mourez qu\'en pleine soumission.',
      zh: '信道的人们啊！你们当真实地敬畏真主，你们除非顺服，切不可死。',
      tr: 'Ey iman edenler! Allah\'a karşı gelmekten nasıl sakınmak gerekiyorsa öylece sakının ve ancak müslümanlar olarak can verin.'
    }
  },
  {
    surahNumber: 4,
    surahNameArabic: 'النساء',
    surahNameEnglish: 'An-Nisa',
    ayahNumber: 1,
    arabicUthmani: 'يَا أَيُّهَا النَّاسُ اتَّقُوا رَبَّكُمُ الَّذِي خَلَقَكُم مِّن نَّفْسٍ وَاحِدَةٍ',
    translations: {
      en: 'O mankind, fear your Lord, who created you from one soul.',
      bn: 'হে মানবসমাজ! তোমরা তোমাদের প্রতিপালককে ভয় কর, যিনি তোমাদেরকে এক ব্যক্তি থেকে সৃষ্টি করেছেন।',
      ur: 'اے لوگو! اپنے پروردگار سے ڈرو جس نے تم کو ایک جان سے پیدا کیا۔',
      fr: 'Ô hommes! Craignez votre Seigneur qui vous a créés d\'un seul être.',
      zh: '众人啊！你们当敬畏你们的主，他从一个人创造了你们。',
      tr: 'Ey insanlar! Sizi tek bir nefisten yaratan Rabbinizden korkun.'
    }
  },
  {
    surahNumber: 33,
    surahNameArabic: 'الأحزاب',
    surahNameEnglish: 'Al-Ahzab',
    ayahNumber: 70,
    arabicUthmani: 'يَا أَيُّهَا الَّذِينَ آمَنُوا اتَّقُوا اللَّهَ وَقُولُوا قَوْلًا سَدِيدًا',
    translations: {
      en: 'O you who have believed, fear Allah and speak words of appropriate justice.',
      bn: 'হে মুমিনগণ! তোমরা আল্লাহকে ভয় কর এবং সঠিক ও সরল কথা বল।',
      ur: 'اے ایمان والو! اللہ سے ڈرو اور سیدھی اور سچی بات کہا کرو۔',
      fr: 'Ô vous qui croyez! Craignez Allah et parlez avec droiture.',
      zh: '信道的人们啊！你们应当敬畏真主，应当说正直的话。',
      tr: 'Ey iman edenler! Allah\'a karşı saygılı olun ve doğru söz söyleyin.'
    }
  },
  {
    surahNumber: 33,
    surahNameArabic: 'الأحزاب',
    surahNameEnglish: 'Al-Ahzab',
    ayahNumber: 71,
    arabicUthmani: 'يُصْلِحْ لَكُمْ أَعْمَالَكُمْ وَيَغْفِرْ لَكُمْ ذُنُوبَكُمْ ۗ وَمَن يُطِعِ اللَّهَ وَرَسُولَهُ فَقَدْ فَازَ فَوْزًا عَظِيمًا',
    translations: {
      en: 'He will [then] amend for you your deeds and forgive you your sins. And whoever obeys Allah and His Messenger has certainly attained a great attainment.',
      bn: 'তিনি তোমাদের জন্য তোমাদের কাজকর্ম সংশোধন করবেন এবং তোমাদের পাপসমূহ ক্ষমা করবেন। আর যে ব্যক্তি আল্লাহ ও তাঁর রাসূলের আনুগত্য করে, সে মহা সাফল্য অর্জন করল।',
      ur: 'وہ تمہارے اعمال کو تمہارے لئے سنوار دے گا اور تمہارے گناہ بخش دے گا۔ اور جو اللہ اور اس کے رسول کی اطاعت کرے اس نے بڑی کامیابی حاصل کرلی۔',
      fr: 'Il améliorera vos actions et vous pardonnera vos péchés. Quiconque obéit à Allah et à Son messager a déjà remporté un immense succès.',
      zh: '他就改善你们的行为，赦宥你们的罪过。服从真主及其使者的人，确已获得重大的成功。',
      tr: 'Böyle davranırsanız, Allah işlerinizi düzeltir ve günahlarınızı bağışlar. Kim Allah\'a ve Resûlüne itaat ederse, muhakkak büyük bir başarıya ulaşmıştır.'
    }
  },
  // Friday Prayer Call Verse
  {
    surahNumber: 62,
    surahNameArabic: 'الجمعة',
    surahNameEnglish: "Al-Jumu'ah",
    ayahNumber: 9,
    arabicUthmani: 'يَا أَيُّهَا الَّذِينَ آمَنُوا إِذَا نُودِيَ لِلصَّلَاةِ مِن يَوْمِ الْجُمُعَةِ فَاسْعَوْا إِلَىٰ ذِكْرِ اللَّهِ وَذَرُوا الْبَيْعَ',
    translations: {
      en: 'O you who have believed, when [the adhan] is called for the prayer on the day of Jumu\'ah [Friday], then hasten to the remembrance of Allah and leave business.',
      bn: 'হে মুমিনগণ! জুমার দিনে যখন নামাযের আযান দেওয়া হয়, তখন আল্লাহর স্মরণের দিকে ছুটে যাও এবং কেনা-বেচা বন্ধ কর।',
      ur: 'اے ایمان والو! جب جمعہ کے دن نماز کی اذان دی جائے تو اللہ کے ذکر کی طرف لپکو اور خرید و فروخت چھوڑ دو۔',
      fr: 'Ô vous qui avez cru! Quand on appelle à la prière du jour du Vendredi, accourez à l\'invocation d\'Allah et laissez tout commerce.',
      zh: '信道的人们啊！当主麻日听到礼拜的呼唤时，你们当赶往记念真主，放下买卖。',
      tr: 'Ey iman edenler! Cuma günü namaza çağrıldığınız zaman, hemen Allah\'ı anmaya koşun ve alışverişi bırakın.'
    }
  },
  // Surah Al-Inshirah (Ash-Sharh)
  {
    surahNumber: 94,
    surahNameArabic: 'الشرح',
    surahNameEnglish: 'Ash-Sharh',
    ayahNumber: 5,
    arabicUthmani: 'فَإِنَّ مَعَ الْعُسْرِ يُسْرًا',
    translations: {
      en: 'For indeed, with hardship [will be] ease.',
      bn: 'নিশ্চয় কষ্টের সাথেই স্বস্তি আছে।',
      ur: 'بے شک مشکل کے ساتھ آسانی ہے۔',
      fr: 'Après la difficulté vient certes la facilité!',
      zh: '与艰难相伴的，确是容易。',
      tr: 'Şüphesiz güçlükle beraber bir kolaylık vardır.'
    }
  },
  {
    surahNumber: 94,
    surahNameArabic: 'الشرح',
    surahNameEnglish: 'Ash-Sharh',
    ayahNumber: 6,
    arabicUthmani: 'إِنَّ مَعَ الْعُسْرِ يُسْرًا',
    translations: {
      en: 'Indeed, with hardship [will be] ease.',
      bn: 'নিশ্চয় কষ্টের সাথেই স্বস্তি আছে।',
      ur: 'یقیناً تنگی کے ساتھ فراخی ہے۔',
      fr: 'Oui, après la difficulté vient certes la facilité!',
      zh: '与艰难相伴的，确是容易。',
      tr: 'Gerçekten güçlükle beraber bir kolaylık vardır.'
    }
  },
  // Surah Al-Asr
  {
    surahNumber: 103,
    surahNameArabic: 'العصر',
    surahNameEnglish: "Al-'Asr",
    ayahNumber: 1,
    arabicUthmani: 'وَالْعَصْرِ',
    translations: {
      en: 'By time,',
      bn: 'কালের শপথ,',
      ur: 'زمانہ کی قسم،',
      fr: 'Par le Temps!',
      zh: '以时光发誓，',
      tr: 'Asra yemin olsun ki,'
    }
  },
  {
    surahNumber: 103,
    surahNameArabic: 'العصر',
    surahNameEnglish: "Al-'Asr",
    ayahNumber: 2,
    arabicUthmani: 'إِنَّ الْإِنسَانَ لَفِي خُسْرٍ',
    translations: {
      en: 'Indeed, mankind is in loss,',
      bn: 'নিশ্চয় মানুষ ক্ষতির মধ্যে নিমজ্জিত,',
      ur: 'بے شک انسان بڑے خسارے میں ہے،',
      fr: 'L\'homme est certes en perdition,',
      zh: '一切人确是在亏折之中，',
      tr: 'Gerçekten insan ziyan içindedir.'
    }
  },
  {
    surahNumber: 103,
    surahNameArabic: 'العصر',
    surahNameEnglish: "Al-'Asr",
    ayahNumber: 3,
    arabicUthmani: 'إِلَّا الَّذِينَ آمَنُوا وَعَمِلُوا الصَّالِحَاتِ وَتَوَاصَوْا بِالْحَقِّ وَتَوَاصَوْا بِالصَّبْرِ',
    translations: {
      en: 'Except for those who have believed and done righteous deeds and advised each other to truth and advised each other to patience.',
      bn: 'তারা ছাড়া যারা ঈমান এনেছে ও সৎকাজ করেছে এবং পরস্পরকে সত্যের উপদেশ দিয়েছে ও ধৈর্যের উপদেশ দিয়েছে।',
      ur: 'سوائے ان لوگوں کے جو ایمان لائے اور نیک عمل کیے اور جنہوں نے ایک دوسرے کو حق کی وصیت کی اور صبر کی تلقین کی۔',
      fr: 'sauf ceux qui croient et accomplissent les bonnes œuvres, s\'enjoignent mutuellement la vérité et s\'enjoignent mutuellement l\'endurance.',
      zh: '唯有信道而且行善，并以真理相劝，以坚忍相勉的人则不然。',
      tr: 'Ancak iman edip salih ameller işleyenler, birbirlerine hakkı tavsiye edenler ve sabrı tavsiye edenler müstesnadır.'
    }
  },
  // Ayat Al-Kursi
  {
    surahNumber: 2,
    surahNameArabic: 'البقرة',
    surahNameEnglish: 'Al-Baqarah',
    ayahNumber: 255,
    arabicUthmani: 'اللَّهُ لَا إِلَٰهَ إِلَّا هُوَ الْحَيُّ الْقَيُّومُ ۚ لَا تَأْخُذُهُ سِنَةٌ وَلَا نَوْمٌ ۚ لَّهُ مَا فِي السَّمَاوَاتِ وَمَا فِي الْأَرْضِ',
    translations: {
      en: 'Allah - there is no deity except Him, the Ever-Living, the Sustainer of [all] existence. Neither drowsiness overtakes Him nor sleep.',
      bn: 'আল্লাহ, তিনি ছাড়া কোন সত্য ইলাহ নেই। তিনি চিরঞ্জীব, সর্বসত্তার ধারক। তাঁকে তন্দ্রাও স্পর্শ করতে পারে না এবং নিদ্রাও নয়।',
      ur: 'اللہ وہ ہے جس کے سوا کوئی معبود نہیں، وہ زندہ ہے سب کو سنبھالنے والا، نہ اسے اونگھ آتی ہے نہ نیند۔',
      fr: 'Allah! Point de divinité à part Lui, le Vivant, Celui qui subsiste par Lui-même "Al-Qayyoum". Ni somnolence ni sommeil ne Le saisissent.',
      zh: '真主，除他外绝无应受崇拜的；他是永生不灭的，是维护万物的；瞌睡不能怠倦他，睡眠不能克服他。',
      tr: 'Allah, O\'ndan başka ilah yoktur; O diridir, her şeyin varlığı O\'na bağlıdır. O\'nu ne uyuklama tutar ne de uyku.'
    }
  },
  // Surah Al-Ikhlas
  {
    surahNumber: 112,
    surahNameArabic: 'الإخلاص',
    surahNameEnglish: 'Al-Ikhlas',
    ayahNumber: 1,
    arabicUthmani: 'قُلْ هُوَ اللَّهُ أَحَدٌ',
    translations: {
      en: 'Say, "He is Allah, [who is] One,',
      bn: 'বলুন, তিনিই আল্লাহ, এক-অদ্বিতীয়,',
      ur: 'کہو کہ وہ اللہ ایک ہے،',
      fr: 'Dis: «Il est Allah, Unique.',
      zh: '你说：他是真主，是独一的主；',
      tr: 'De ki: O Allah birdir.'
    }
  },
  {
    surahNumber: 112,
    surahNameArabic: 'الإخلاص',
    surahNameEnglish: 'Al-Ikhlas',
    ayahNumber: 2,
    arabicUthmani: 'اللَّهُ الصَّمَدُ',
    translations: {
      en: 'Allah, the Eternal Refuge.',
      bn: 'আল্লাহ অমুখাপেক্ষী,',
      ur: 'اللہ بے نیاز ہے،',
      fr: 'Allah, Le Seul à être imploré pour ce que nous désirons.',
      zh: '真主是万物所仰赖的；',
      tr: 'Allah Samed\'dir (her şey O\'na muhtaçtır).'
    }
  },
  // Surah Al-Fatihah (Complete 7 Ayahs)
  {
    surahNumber: 1,
    surahNameArabic: 'الفاتحة',
    surahNameEnglish: 'Al-Fatihah',
    ayahNumber: 1,
    arabicUthmani: 'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ',
    translations: {
      en: 'In the name of Allah, the Entirely Merciful, the Especially Merciful.',
      bn: 'পরম করুণাময় অসীম দয়ালু আল্লাহর নামে।',
      ur: 'اللہ کے نام سے جو رحمن و رحیم ہے۔',
      fr: 'Au nom d\'Allah, le Tout Miséricordieux, le Très Miséricordieux.',
      zh: '奉至仁至慈的真主之名。',
      tr: 'Rahmân ve Rahîm olan Allah\'ın adıyla.'
    }
  },
  {
    surahNumber: 1,
    surahNameArabic: 'الفاتحة',
    surahNameEnglish: 'Al-Fatihah',
    ayahNumber: 2,
    arabicUthmani: 'الْحَمْدُ لِلَّهِ رَبِّ الْعَالَمِينَ',
    translations: {
      en: '[All] praise is [due] to Allah, Lord of the worlds -',
      bn: 'সমস্ত প্রশংসা একমাত্র আল্লাহর জন্য, যিনি সকল সৃষ্টির প্রতিপালক।',
      ur: 'سب تعریفیں اللہ ہی کے لیے ہیں جو تمام جہانوں کا پالنے والا ہے۔',
      fr: 'Louange à Allah, Seigneur de l\'univers.',
      zh: '一切赞颂，全归真主，众世界的主。',
      tr: 'Hamd, âlemlerin Rabbi olan Allah\'a mahsustur.'
    }
  },
  {
    surahNumber: 1,
    surahNameArabic: 'الفاتحة',
    surahNameEnglish: 'Al-Fatihah',
    ayahNumber: 3,
    arabicUthmani: 'الرَّحْمَٰنِ الرَّحِيمِ',
    translations: {
      en: 'The Entirely Merciful, the Especially Merciful,',
      bn: 'যিনি পরম করুণাময় ও পরম দয়ালু,',
      ur: 'جو بڑا مہربان اور نہایت رحم والا ہے۔',
      fr: 'Le Tout Miséricordieux, le Très Miséricordieux,',
      zh: '至仁至慈的主，',
      tr: 'O, Rahmân ve Rahîm’dir.'
    }
  },
  {
    surahNumber: 1,
    surahNameArabic: 'الفاتحة',
    surahNameEnglish: 'Al-Fatihah',
    ayahNumber: 4,
    arabicUthmani: 'مَالِكِ يَوْمِ الدِّينِ',
    translations: {
      en: 'Sovereign of the Day of Recompense.',
      bn: 'যিনি বিচার দিবসের মালিক।',
      ur: 'روز جزا کا مالک و مختار ہے۔',
      fr: 'Maître du Jour de la rétribution.',
      zh: '报应日的主。',
      tr: 'Ceza (hesap) gününün sahibidir.'
    }
  },
  {
    surahNumber: 1,
    surahNameArabic: 'الفاتحة',
    surahNameEnglish: 'Al-Fatihah',
    ayahNumber: 5,
    arabicUthmani: 'إِيَّاكَ نَعْبُدُ وَإِيَّاكَ نَسْتَعِينُ',
    translations: {
      en: 'It is You we worship and You we ask for help.',
      bn: 'আমরা কেবল আপনারই ইবাদত করি এবং কেবল আপনারই সাহায্য চাই।',
      ur: 'ہم تیری ہی عبادت کرتے ہیں اور تجھ ہی سے مدد مانگتے ہیں۔',
      fr: 'C\'est Toi [Seul] que nous adorons, et c\'est Toi [Seul] dont nous implorons secours.',
      zh: '我们只崇拜你，只求你佑助。',
      tr: '(Rabbimiz!) Ancak sana kulluk eder ve yalnız senden yardım dileriz.'
    }
  },
  {
    surahNumber: 1,
    surahNameArabic: 'الفاتحة',
    surahNameEnglish: 'Al-Fatihah',
    ayahNumber: 6,
    arabicUthmani: 'اهْدِنَا الصِّرَاطَ الْمُسْتَقِيمَ',
    translations: {
      en: 'Guide us to the straight path -',
      bn: 'আমাদের সরল-সঠিক পথ প্রদর্শন করুন -',
      ur: 'ہمیں سیدھے راستے کی ہدایت فرما -',
      fr: 'Guide-nous dans le droit chemin,',
      zh: '求你引领我们走上正路，',
      tr: 'Bizi doğru yola ilet;'
    }
  },
  {
    surahNumber: 1,
    surahNameArabic: 'الفاتحة',
    surahNameEnglish: 'Al-Fatihah',
    ayahNumber: 7,
    arabicUthmani: 'صِرَاطَ الَّذِينَ أَنْعَمْتَ عَلَيْهِمْ غَيْرِ الْمَغْضُوبِ عَلَيْهِمْ وَلَا الضَّالِّينَ',
    translations: {
      en: 'The path of those upon whom You have bestowed favor, not of those who have evoked [Your] anger or of those who are astray.',
      bn: 'তাদের পথ যাদের আপনি অনুগ্রহ করেছেন, যাদের উপর আপনার ক্রোধ আপতিত হয়নি এবং যারা পথভ্রষ্টও নয়।',
      ur: 'ان لوگوں کا راستہ جن پر تو نے انعام فرمایا، نہ ان کا راستہ جن پر غضب نازل ہوا اور نہ گمراہوں کا۔',
      fr: 'Le chemin de ceux que Tu as comblés de faveurs, non pas de ceux qui ont encouru Ta colère, ni des égarés.',
      zh: '引导我们走你所赐福者的路，不是受谴怒者的路，也不是迷误者的路。',
      tr: 'Kendilerine lütuf ve ikramda bulunduğun kimselerin yoluna; gazaba uğramışların ve sapmışların yoluna değil.'
    }
  },
  // Ayat Al-Kursi (2:255)
  {
    surahNumber: 2,
    surahNameArabic: 'البقرة',
    surahNameEnglish: 'Al-Baqarah',
    ayahNumber: 255,
    arabicUthmani: 'اللَّهُ لَا إِلَٰهَ إِلَّا هُوَ الْحَيُّ الْقَيُّومُ ۚ لَا تَأْخُذُهُ سِنَةٌ وَلَا نَوْمٌ',
    translations: {
      en: 'Allah - there is no deity except Him, the Ever-Living, the Sustainer of all existence. Neither drowsiness overtakes Him nor sleep.',
      bn: 'আল্লাহ, তিনি ছাড়া অন্য কোন সত্য উপাস্য নেই; তিনি চিরঞ্জীব, সবকিছুর ধারক। তন্দ্রা বা ঘুম তাঁকে স্পর্শ করে না।',
      ur: 'اللہ وہ ہے جس کے سوا کوئی معبود نہیں، وہ زندہ ہے اور سب کو سنبھالنے والا ہے۔ اسے نہ اونگھ آتی ہے نہ نیند۔',
      fr: 'Allah! Point de divinité à part Lui, le Vivant, Celui qui subsiste par Lui-même "Al-Qayyoum". Ni somnolence ni sommeil ne Le saisissent.',
      zh: '真主，除他外绝无应受崇拜的；他是永生不灭的，是维护万物的；瞌睡不能犯他，睡眠不能克服他。',
      tr: 'Allah, kendisinden başka hiçbir ilâh bulunmayandır. O, Hayy\'dır, Kayyûm\'dur. O\'nu ne bir uyuklama tutabilir, ne de bir uyku.'
    }
  },
  // Surah Al-Ikhlas (112:1-4)
  {
    surahNumber: 112,
    surahNameArabic: 'الإخلاص',
    surahNameEnglish: 'Al-Ikhlas',
    ayahNumber: 1,
    arabicUthmani: 'قُلْ هُوَ اللَّهُ أَحَدٌ ۞ اللَّهُ الصَّمَدُ ۞ لَمْ يَلِدْ وَلَمْ يُولَدْ ۞ وَلَمْ يَكُن لَّهُ كُفُوًا أَحَدٌ',
    translations: {
      en: 'Say, "He is Allah, [who is] One, Allah, the Eternal Refuge. He neither begets nor is born, Nor is there to Him any equivalent."',
      bn: 'বলুন, তিনিই আল্লাহ, এক-অদ্বিতীয়। আল্লাহ কারো মুখাপেক্ষী নন। তিনি কাউকে জন্ম দেননি এবং তাঁকেও কেউ জন্ম দেয়নি। এবং তাঁর সমকক্ষ কেউই নেই।',
      ur: 'کہہ دیجیے کہ وہ اللہ ایک ہے۔ اللہ بے نیاز ہے۔ نہ اس کی کوئی اولاد ہے اور نہ وہ کسی کی اولاد ہے۔ اور نہ کوئی اس کا ہمسر ہے۔',
      fr: 'Dis: "Il est Allah, Unique. Allah, Le Seul à être imploré pour ce que nous désirons. Il n\'a jamais engendré, n\'a pas été engendré non plus. Et nul n\'est égal à Lui".',
      zh: '你说：他是真主，是独一的主；真主是万物所仰赖的；他没有生产，也没有被生产；没有任何物可以做他的匹敌。',
      tr: 'De ki: O Allah birdir. Allah Samed\'dir. O doğurmamış ve doğmamıştır. O\'nun hiçbir dengi yoktur.'
    }
  }
];

// Pre-normalize all indexed verses
const INDEXED_VERSES = QURAN_VERSES.map(v => ({
  ...v,
  normalizedArabic: normalizeArabic(v.arabicUthmani),
  tokens: normalizeArabic(v.arabicUthmani).split(/\s+/)
}));

/**
 * Detects if the given Arabic text contains a Quranic Ayah
 * @param {string} text - Spoken Arabic text from STT stream
 * @returns {object|null} Matched Ayah with canonical text & translations, or null
 */
function detectAyah(text) {
  if (!text || text.trim().length < 4) return null;
  const normalizedInput = normalizeArabic(text);
  const inputTokens = normalizedInput.split(/\s+/).filter(Boolean);

  let bestMatch = null;
  let bestScore = 0;

  for (const verse of INDEXED_VERSES) {
    const verseTokens = verse.tokens;

    // Check 1: Exact substring match
    if (normalizedInput.includes(verse.normalizedArabic) || verse.normalizedArabic.includes(normalizedInput)) {
      const matchLength = Math.min(normalizedInput.length, verse.normalizedArabic.length);
      const maxLength = Math.max(normalizedInput.length, verse.normalizedArabic.length);
      const ratio = matchLength / maxLength;
      if (ratio >= 0.55 && ratio > bestScore) {
        bestScore = ratio;
        bestMatch = verse;
      }
    }

    // Check 2: Token overlap (for spoken variations or minor STT dropouts)
    let matchedTokenCount = 0;
    for (const t of inputTokens) {
      if (verseTokens.includes(t)) {
        matchedTokenCount++;
      }
    }

    const tokenRatio = matchedTokenCount / Math.max(verseTokens.length, 1);
    if (tokenRatio >= 0.65 && tokenRatio > bestScore) {
      bestScore = tokenRatio;
      bestMatch = verse;
    }
  }

  if (bestMatch && bestScore >= 0.55) {
    return {
      isAyah: true,
      confidence: Math.min(Math.round(bestScore * 100), 99),
      surahNumber: bestMatch.surahNumber,
      surahNameArabic: bestMatch.surahNameArabic,
      surahNameEnglish: bestMatch.surahNameEnglish,
      ayahNumber: bestMatch.ayahNumber,
      reference: `${bestMatch.surahNameEnglish} ${bestMatch.surahNumber}:${bestMatch.ayahNumber}`,
      arabicUthmani: bestMatch.arabicUthmani,
      translations: bestMatch.translations
    };
  }

  return null;
}

module.exports = {
  normalizeArabic,
  detectAyah,
  INDEXED_VERSES
};
