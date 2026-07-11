import { ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ServiceIcon } from "@/components/ServiceIcon";
import { SERVICES } from "@/config/services";
import accountsLogo from "@/assets/logos/accounts-logo.svg";

/** Only these products have a punchy, translated capability caption (see i18n `welcome.showcase.*`). */
const SHOWCASE_CAPTION_IDS = new Set([
  "envia-shipping",
  "envia-fulfillment",
  "envia-returns",
  "ecart-pay",
  "ecart-banking",
  "ecart-api",
  "parapaquetes",
  "tendencys-partners",
]);

type WelcomeScreenProps = {
  onSignIn: () => void;
  onCreateAccount: () => void;
};

/**
 * Branded landing state shown when there is no session and no usable device
 * key — invites the visitor to sign in or create an account instead of being
 * dropped straight into the Accounts webview. Purely presentational; all
 * session/auth logic lives in LoginPage.
 */
export function WelcomeScreen({ onSignIn, onCreateAccount }: WelcomeScreenProps) {
  const { t } = useTranslation();

  return (
    <div className="flex h-screen bg-white">
      <div className="flex w-full flex-col items-center justify-center px-8 md:w-[440px] md:shrink-0">
        <div className="flex w-full max-w-sm flex-col gap-6">
          <img src={accountsLogo} alt="Tendencys" className="h-8 w-auto" />
          <div className="flex flex-col gap-2">
            <h1 className="text-2xl font-semibold leading-tight text-foreground">
              {t("welcome.title")}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t("welcome.subtitle")}
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Button className="w-full" onClick={onSignIn}>
              {t("welcome.signIn")}
            </Button>
            <Button
              variant="outline"
              className="w-full"
              onClick={onCreateAccount}
            >
              {t("welcome.createAccount")}
            </Button>
          </div>
          <div className="flex items-start gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{t("welcome.secureNote")}</span>
          </div>
        </div>
      </div>
      <div className="hidden flex-1 flex-col justify-center overflow-y-auto bg-primary px-10 py-12 text-white md:flex">
        <div className="mx-auto flex w-full max-w-lg flex-col gap-6">
          <p className="text-xs font-medium uppercase tracking-wide text-white/60">
            {t("welcome.showcaseHeading")}
          </p>
          <div className="grid grid-cols-2 gap-4">
            {SERVICES.map((service) => (
              <div
                key={service.id}
                className="flex flex-col gap-2 rounded-lg bg-white/5 p-4"
              >
                <span
                  className="flex h-8 w-8 items-center justify-center rounded-md"
                  style={{ backgroundColor: `${service.accentColor}33` }}
                >
                  <ServiceIcon
                    icon={service.icon}
                    className="h-4 w-4"
                    style={{ color: service.accentColor }}
                  />
                </span>
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">{service.name}</span>
                  {SHOWCASE_CAPTION_IDS.has(service.id) && (
                    <span className="text-xs text-white/70">
                      {t(`welcome.showcase.${service.id}`)}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
