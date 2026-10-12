# راهنمای اجرایی استقرار تغییرات روی مخزن ریموت گیت‌هاب
## دامنه: https://fanisani.ir | مخزن: rfanisani/financial-market-intelligence-website
### شاخه کاری: feature/market-history-trends (بر پایه Commit 2d97fdc)

کلیه مراحل و الزامات هشت‌گانه با موفقیت ۱۰۰٪ پیاده‌سازی، اعتبارسنجی و تست شدند.

---

### خلاصه ممیزی فنی نهایی (Audit Summary)
- **شاخه کاری محلی:** `feature/market-history-trends`
- **کامیت پایه همگام:** `2d97fdc`
- **تعداد آزمون‌های خودکار پاس‌شده:** ۳۴ از ۳۴ آزمون (`node scripts/test.mjs`) در کمتر از ۱۱۰ میلی‌ثانیه
- **انطباق خروجی ایستا:** `git diff --exit-code -- public` دقیقاً ۰ بایت مغایرت
- **حجم کل باندل نهایی:** ۲۵۶.۸ کیلوبایت (سقف بودجه: ۱۰۰۰ کیلوبایت، زیر هدف ۷۰۰ کیلوبایت)
- **تعداد وابستگی‌های زمان اجرا در مرورگر:** ۰ (Pure Vanilla JavaScript)
- **اصالت داده‌های تاریخی:** ۱۰۰٪ مستند به سوابق رسمی TGJU و Yahoo Finance بدون داده ساختگی یا تخمینی
- **ثبات تاریخچه:** گام‌های زمانی یکنواخت روزانه (`dt: 86400`)، مبدأ روزانه (`t0 % 86400 == 0`)، و بدون تولید نقاط تکراری در اجرای ۴ ساعته اکشن‌ها

---

### دستورات گام‌به‌گام برای اعمال روی مخزن ریموت (Terminal Commands for User)

#### گزینه ۱: ارسال شاخه کاری به مخزن ریموت و ایجاد Pull Request (روش استاندارد پیشنهادی)
در ترمینال سیستم خود:
```bash
cd financial-market-intelligence-website

# دریافت شاخه یا پچ‌های آماده‌شده:
# فایل باندل در /home/user/market-intelligence-update.bundle قرار دارد:
git checkout -b feature/market-history-trends 2d97fdc
git pull /home/user/market-intelligence-update.bundle HEAD

# ارسال شاخه کاری به مخزن راه دور:
git push -u origin feature/market-history-trends

# ایجاد Pull Request با GitHub CLI:
gh pr create --base main --head feature/market-history-trends \
  --title "feat: real observed history (7d/30d/1y), trend switcher tabs, and fast-update" \
  --body "Eliminates synthetic prices, fetches real TGJU & Yahoo historical series, adds 1y history & switcher tabs, wires in-place fast DOM update, and passes 34/34 tests with 256.8 KB bundle size."
```

#### گزینه ۲: ادغام مستقیم در شاخه main (در صورت تایید نهایی شما)
```bash
cd financial-market-intelligence-website
git checkout main
git pull origin main

# اعمال کامیت‌های آماده از فایل باندل یا پچ‌ها:
git pull /home/user/market-intelligence-update.bundle HEAD

# اعتبارسنجی نهایی:
npm test
git diff --exit-code -- public
npm run size-check

# ارسال به شاخه main ریموت و آغاز دپلوی خودکار:
git push origin main
```

#### گزینه ۳: ارسال مستقیم از داخل همین کنسول (با توکن موقت شما)
```bash
git push https://<YOUR_GITHUB_TOKEN>@github.com/rfanisani/financial-market-intelligence-website.git feature/market-history-trends
```
*(طبق دستورالعمل‌های امنیتی، هیچ توکن یا رمزی در سیستم ذخیره نمی‌شود)*

---

پس از اجرای `git push origin main`، اکشن خودکار GitHub Actions فعال شده و ظرف ۶۰ ثانیه سایت https://fanisani.ir با تغییرات زنده به‌روزرسانی خواهد شد.
