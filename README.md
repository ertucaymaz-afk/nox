# WahooGPT Toolkit V2 Build Host

Bu depo WahooGPT için bağımsız `40 Eklenti + 32 Çekirdek Özellik` kaynak paketini üretmek amacıyla kullanılır.

- Ana WahooGPT/V18 kaynaklarına gömülü değildir.
- `scripts/generate-package.js` gerçek Node.js kaynak ağacını üretir.
- GitHub Actions çıktısı ZIP artifact olarak yükler.
- Bulut AI sağlayıcıları kullanıcı kendi API anahtarı ve kotasıyla çalıştırır; yerel analiz eklentileri ücretsizdir.
