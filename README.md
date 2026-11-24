# KLM PDF

Pembaca & editor PDF offline bergaya Acrobat. Tersedia sebagai **PWA** (instal dari browser) dan **aplikasi Windows .exe** yang bisa dijadikan pembuka PDF default.

## Fitur

- **Baca**: zoom (paskan lebar/halaman, Ctrl+scroll), thumbnail, penanda (bookmark), cari teks, pilih & salin teks, mode gelap, banyak tab sekaligus
- **Edit teks yang ada** — klik teks di PDF lalu ketik ulang (warna latar & huruf diambil otomatis), kosongkan untuk menghapus
- **Tambah**: teks, gambar, tanda tangan (gambar/ketik/unggah, bisa disimpan), stempel, centang ✓ ✗ ●, tanggal, catatan komentar
- **Anotasi**: sorot, garis bawah, coret, pena bebas, kotak, lingkaran, garis, panah, penutup putih (whiteout)
- **Halaman**: urutkan (seret), putar, hapus, duplikat, sisip halaman kosong, sisip/gabung PDF, ekstrak, pisah (ZIP)
- **Scan dokumen**: dari kamera (webcam/HP) atau foto → tepi kertas terdeteksi otomatis, perspektif diluruskan, filter Dokumen/Hitam-putih/Abu-abu → PDF baru atau disisipkan ke dokumen
- **Cetak ala Acrobat** (Ctrl+P): pratinjau langsung, pilih printer, salinan, bolak-balik, rentang/ganjil/genap/urutan terbalik, ukuran kertas (A4, F4, Letter, Legal, A3, A5, B5), orientasi, skala (sesuaikan/perkecil/100%/kustom), 2–16 halaman per lembar, hitam-putih, kualitas 150–300 dpi, dengan/tanpa anotasi. Versi .exe mencetak langsung ke printer Windows; versi PWA meneruskan ke dialog cetak browser.
- **Lainnya**: isi formulir PDF, watermark, nomor halaman, ekspor ke PNG/JPG, properti dokumen
- Undo/redo, salin-tempel objek, tempel gambar dari clipboard, tarik & lepas file
- Semua diproses di perangkat — tidak ada yang diunggah

## Struktur

```
web/            → aplikasi (dipakai PWA dan .exe)
electron/       → pembungkus Windows (.exe), membuka file dari Explorer
build/          → ikon aplikasi & ikon file .pdf
BUAT-EXE.bat    → klik dua kali untuk membuat installer di Windows
```

## Membuat installer .exe

**Cara 1 — di PC Windows**: pasang [Node.js LTS](https://nodejs.org), lalu klik dua kali `BUAT-EXE.bat`. Installer muncul di folder `dist\KLM-PDF-Setup-1.0.0.exe`.

**Cara 2 — otomatis lewat GitHub**: unggah folder ini ke repo GitHub → tab **Actions** → **Build Windows .exe** → **Run workflow**. Setelah selesai, unduh `KLM-PDF-Setup` dari bagian *Artifacts*. (Push tag `v1.0.0` juga otomatis membuat Release berisi .exe.)

Installer mendaftarkan KLM PDF sebagai pembuka file `.pdf`. Untuk menjadikannya **default**: klik kanan file PDF → *Open with* → *Choose another app* → **KLM PDF** → *Always*. (Atau di aplikasi: menu **Bantuan → Jadikan aplikasi PDF default**.)

## PWA (GitHub Pages)

Workflow `pages.yml` men-deploy folder `web/` ke GitHub Pages setiap push ke `main` (aktifkan dulu: Settings → Pages → Source: **GitHub Actions**). Buka situsnya di Chrome/Edge → klik **Instal**. Setelah terpasang, KLM PDF muncul di menu *Open with* untuk file PDF.

Untuk mencoba lokal: `npm run serve` lalu buka http://localhost:8080.

## Cara kerja fitur lanjutan (v1.1)

- **Semua aksara**: teks Latin biasa memakai huruf standar PDF. Karakter di luar itu (ą, ő, Kirilik, Yunani, Vietnam, dll.) otomatis memakai **Liberation** (dibundel, metriknya identik Arial/Times/Courier). Korea/Jepang/Tiongkok memakai **huruf yang terpasang di komputer** (mis. Malgun Gothic) — disematkan sebagai subset kecil, teks tetap bisa dipilih, disalin, dan dicari. Di versi PWA, browser akan meminta izin "huruf komputer" sekali; di versi .exe otomatis.
- **Arab, Ibrani, Thai, Hindi & emoji** (butuh pembentukan huruf) dirender tajam (5×) per baris agar bentuknya selalu benar.
- **Edit teks** mencocokkan huruf asli dokumen bila tersedia di komputer (mis. Calibri), dan **teks lama benar-benar dihapus** dari isi halaman — tidak tersisa saat disalin atau dicari. "Tutup / hapus area" juga menghapus teks di bawahnya.
- **PDF terenkripsi** (RC4 40/128-bit, AES-128, AES-256) dibuka & diedit penuh dengan teks utuh. Bila file berkata sandi, kata sandinya **tetap dipakai** saat disimpan (AES-256).
- **Kata sandi & keamanan** (menu Berkas): kunci PDF apa pun dengan AES-256, atur izin cetak/salin/ubah, atau hapus kata sandi.
- **Anotasi tetap bisa diedit**: file yang disimpan KLM PDF menyimpan data anotasinya. Saat dibuka lagi di KLM PDF, teks/gambar/tanda tangan bisa dipindah dan diubah. Di aplikasi lain tampil normal.
- **Formulir** dengan isian non-Latin (mis. nama Korea) tampil benar di semua pembaca PDF.
- Halaman yang dihapus dan data lama dibuang dari file (ukuran file tidak membengkak).

Catatan kecil: gambar di bawah "Tutup area" ditutupi (teksnya yang dihapus). Teks di dalam Form XObject (jarang) tidak ikut dihapus.

Pustaka: PDF.js (Apache-2.0), pdf-lib (MIT), JSZip (MIT/GPLv3), Electron (MIT). Huruf Liberation: SIL Open Font License 1.1 (lihat `web/fonts/LICENSE-Liberation.txt`).
