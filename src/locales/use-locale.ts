import type { Locale as AntdLocal } from "antd/es/locale";
import en_US from "antd/locale/en_US";
import dayjs from "dayjs";
import { useTranslation } from "react-i18next";
import { LocalEnum } from "#/enum";

type Locale = keyof typeof LocalEnum;
type Language = {
	locale: Locale;
	icon: string;
	label: string;
	antdLocal: AntdLocal;
};

export const LANGUAGE_MAP: Partial<Record<Locale, Language>> = {
	[LocalEnum.zh_CN]: {
		locale: LocalEnum.zh_CN,
		label: "English",
		icon: "flag-us",
		antdLocal: en_US,
	},
	[LocalEnum.en_US]: {
		locale: LocalEnum.en_US,
		label: "English",
		icon: "flag-us",
		antdLocal: en_US,
	},
};

export default function useLocale() {
	const { t, i18n } = useTranslation();

	const locale = (i18n.resolvedLanguage || LocalEnum.en_US) as Locale;
	const language = LANGUAGE_MAP[locale] || LANGUAGE_MAP[LocalEnum.en_US];

	/**
	 * localstorage -> i18nextLng change
	 */
	const setLocale = (locale: Locale) => {
		i18n.changeLanguage(locale);
		// set lang ant dayjs
		document.documentElement.lang = locale;
		dayjs.locale(locale);
	};

	return {
		t,
		locale,
		language,
		setLocale,
	};
}
