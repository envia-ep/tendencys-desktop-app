import { useEffect, useState } from "react";
import {
  AnimatePresence,
  motion,
  useReducedMotion,
  type Variants,
} from "framer-motion";
import { useTranslation } from "react-i18next";
import { ServiceIcon } from "@/components/ServiceIcon";
import { SERVICES, type ServiceDefinition } from "@/config/services";

import enviaShipping from "@/assets/logos/services/envia-shipping.svg";
import enviaCargo from "@/assets/logos/services/envia-cargo.png";
import enviaFulfillment from "@/assets/logos/services/envia-fulfillment.svg";
import enviaReturns from "@/assets/logos/services/envia-returns.svg";
import parapaquetes from "@/assets/logos/services/parapaquetes.png";
import ecartPay from "@/assets/logos/services/ecart-pay.svg";
import ecartBanking from "@/assets/logos/services/ecart-banking.svg";
import ecartApi from "@/assets/logos/services/ecart-api.svg";
import tendencysPartners from "@/assets/logos/services/tendencys-partners.svg";

/** Real brand logos per service; each renders on its own white rounded plate. */
const LOGO_MAP: Record<string, string> = {
  "envia-shipping": enviaShipping,
  "envia-cargo": enviaCargo,
  "envia-fulfillment": enviaFulfillment,
  "envia-returns": enviaReturns,
  parapaquetes,
  "ecart-pay": ecartPay,
  "ecart-banking": ecartBanking,
  "ecart-api": ecartApi,
  "tendencys-partners": tendencysPartners,
};

/** Products with a punchy, translated capability caption (see i18n `welcome.showcase.*`). */
const SHOWCASE_CAPTION_IDS = new Set([
  "envia-shipping",
  "envia-cargo",
  "envia-fulfillment",
  "envia-returns",
  "ecart-pay",
  "ecart-banking",
  "ecart-api",
  "parapaquetes",
  "tendencys-partners",
]);

const STAT_KEYS = ["companies", "countries", "requests", "carriers"] as const;

const ROTATE_MS = 3800;

function ServiceLogo({
  service,
  size,
}: {
  service: ServiceDefinition;
  size: "sm" | "lg";
}) {
  const logo = LOGO_MAP[service.id];
  if (!logo) {
    return (
      <ServiceIcon
        icon={service.icon}
        className={size === "lg" ? "h-9 w-9" : "h-5 w-5"}
      />
    );
  }

  // Every brand lockup renders at its original color on a white rounded
  // plate (matching the Ecart Pay/Ecart Banking treatment) instead of a
  // white knockout silhouette.
  return (
    <span
      className={`flex items-center justify-center rounded-lg bg-white ${
        size === "lg" ? "px-3.5 py-2.5" : "px-2.5 py-2"
      }`}
    >
      <img
        src={logo}
        alt={service.name}
        className={`w-auto object-contain ${size === "lg" ? "h-7" : "h-4"}`}
        draggable={false}
      />
    </span>
  );
}

export function ServiceShowcase() {
  const { t } = useTranslation();
  const reduce = useReducedMotion();
  const [activeIndex, setActiveIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (reduce || paused) return;
    const id = window.setInterval(() => {
      setActiveIndex((i) => (i + 1) % SERVICES.length);
    }, ROTATE_MS);
    return () => window.clearInterval(id);
  }, [reduce, paused]);

  const featured = SERVICES[activeIndex];

  const container: Variants = {
    hidden: {},
    show: {
      transition: { staggerChildren: 0.06, delayChildren: 0.08 },
    },
  };
  const item: Variants = {
    hidden: reduce ? { opacity: 0 } : { opacity: 0, y: 18 },
    show: {
      opacity: 1,
      y: 0,
      transition: reduce
        ? { duration: 0.2 }
        : { type: "spring", stiffness: 280, damping: 26 },
    },
  };

  return (
    <div
      className="hero-surface relative hidden flex-1 items-center justify-center overflow-hidden text-white md:flex"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="hero-aurora" aria-hidden />
      <div className="hero-grid" aria-hidden />

      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="relative z-10 flex w-full max-w-xl flex-col gap-7 px-12 py-14"
      >
        <motion.div variants={item} className="flex flex-col gap-2">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/60">
            {t("welcome.showcaseHeading")}
          </p>
          <h2 className="text-2xl font-semibold leading-tight text-white">
            {t("welcome.showcaseTagline")}
          </h2>
        </motion.div>

        {/* Spotlight — auto-rotating featured product */}
        <motion.div variants={item}>
          <div className="relative overflow-hidden rounded-2xl border border-white/15 bg-white/[0.07] p-6 backdrop-blur-sm">
            <motion.div
              aria-hidden
              className="pointer-events-none absolute -right-16 -top-16 h-52 w-52 rounded-full blur-3xl"
              style={{ backgroundColor: featured.accentColor }}
              animate={
                reduce
                  ? { opacity: 0.35 }
                  : { opacity: [0.28, 0.5, 0.28], scale: [1, 1.12, 1] }
              }
              transition={
                reduce
                  ? undefined
                  : { duration: 6, repeat: Infinity, ease: "easeInOut" }
              }
            />
            <AnimatePresence mode="wait">
              <motion.div
                key={featured.id}
                initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, y: -12 }}
                transition={{ duration: 0.35, ease: "easeOut" }}
                className="relative flex flex-col gap-4"
              >
                <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-white/80">
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: featured.accentColor }}
                  />
                  {t("welcome.featuredLabel")}
                </span>
                <div className="flex h-14 items-center">
                  <ServiceLogo service={featured} size="lg" />
                </div>
                {SHOWCASE_CAPTION_IDS.has(featured.id) && (
                  <p className="max-w-sm text-sm leading-relaxed text-white/75">
                    {t(`welcome.showcase.${featured.id}`)}
                  </p>
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        </motion.div>

        {/* Service grid */}
        <motion.div variants={item} className="grid grid-cols-3 gap-3">
          {SERVICES.map((service, i) => {
            const isActive = i === activeIndex;
            return (
              <motion.button
                key={service.id}
                type="button"
                onClick={() => setActiveIndex(i)}
                whileHover={reduce ? undefined : { y: -4 }}
                whileTap={reduce ? undefined : { scale: 0.97 }}
                transition={{ type: "spring", stiffness: 400, damping: 25 }}
                aria-pressed={isActive}
                aria-label={service.name}
                className={`card-shine group flex flex-col items-center justify-center gap-2.5 rounded-xl border p-3 text-center transition-colors ${
                  isActive
                    ? "border-white/40 bg-white/15"
                    : "border-white/10 bg-white/[0.04] hover:border-white/25 hover:bg-white/[0.08]"
                }`}
                style={
                  isActive
                    ? { boxShadow: `0 0 0 1px ${service.accentColor}55, 0 12px 30px -12px ${service.accentColor}` }
                    : undefined
                }
              >
                <span className="flex h-8 w-full items-center justify-center">
                  <motion.span
                    className="flex h-full items-center"
                    animate={
                      reduce
                        ? undefined
                        : { y: [0, isActive ? -3 : -2, 0] }
                    }
                    transition={
                      reduce
                        ? undefined
                        : {
                            duration: 3.4,
                            repeat: Infinity,
                            ease: "easeInOut",
                            delay: i * 0.18,
                          }
                    }
                  >
                    <ServiceLogo service={service} size="sm" />
                  </motion.span>
                </span>
                <span className="text-[11px] font-medium leading-tight text-white/85">
                  {service.name}
                </span>
              </motion.button>
            );
          })}
        </motion.div>

        {/* Trust stats */}
        <motion.div
          variants={item}
          className="grid grid-cols-4 gap-3 border-t border-white/10 pt-6"
        >
          {STAT_KEYS.map((key) => (
            <div key={key} className="flex flex-col gap-0.5">
              <span className="text-lg font-semibold text-white">
                {t(`welcome.stats.${key}`)}
              </span>
              <span className="text-[10px] uppercase tracking-wide text-white/55">
                {t(`welcome.stats.${key}Label`)}
              </span>
            </div>
          ))}
        </motion.div>
      </motion.div>
    </div>
  );
}
