import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en/common.json";
import es from "./locales/es/common.json";
import pt from "./locales/pt/common.json";
import hi from "./locales/hi/common.json";
import it from "./locales/it/common.json";
import fr from "./locales/fr/common.json";
import zh from "./locales/zh/common.json";
import { detectLanguage } from "./lib/locale";

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    es: { translation: es },
    pt: { translation: pt },
    hi: { translation: hi },
    it: { translation: it },
    fr: { translation: fr },
    zh: { translation: zh },
  },
  lng: detectLanguage(),
  fallbackLng: "en",
  interpolation: {
    escapeValue: false,
  },
});

export default i18n;
