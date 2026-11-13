export const DEFAULT_KEYWORDS = `
抱歉
对不起
歉意
很遗憾
遗憾的是
无法继续
不能继续
无法提供
不能提供
无法满足
不能满足
无法协助
不能协助
无法帮助
不能帮助
无法回答
不能回答
无法完成
不能完成
不便提供
不适合
不被允许
超出我的能力
超出能力范围
违反政策
违反规定
不符合政策
對不起
歉意
很遺憾
遺憾的是
無法繼續
不能繼續
無法提供
不能提供
無法滿足
不能滿足
無法協助
不能協助
無法幫助
不能幫助
無法回答
不能回答
無法完成
不能完成
不便提供
不適合
不被允許
超出我的能力
超出能力範圍
違反政策
違反規定
不符合政策
sorry
apologize
apologise
apologies
I am sorry
I'm sorry
I apologize
I apologise
my apologies
I am unable
I'm unable
I cannot
I can't
I’m unable
I’m not able
I'm not able
I am not able
I must decline
I have to decline
I won't be able
I will not be able
I will not provide
I do not feel comfortable
I don't feel comfortable
I’m not comfortable
I'm not comfortable
against my guidelines
against my policy
contrary to my guidelines
outside my capabilities
beyond my capabilities
unable to assist
unable to help
unable to provide
unable to continue
cannot assist
cannot help
cannot provide
cannot continue
can't assist
can't help
can't provide
can't continue
cannot
can't
I must refuse
I have to refuse
I cannot comply
I can't comply
I won't comply
not allowed
not permitted
`;

export const APOLOGY_MAX_LENGTH = 1000;

const ZERO_WIDTH_CHARACTERS = /[\u200B-\u200D\u2060\uFEFF]/g;
const THINK_BLOCKS = /<think\b[^>]*>[\s\S]*?(?:<\/think\s*>|$)/gi;
const ASCII_WORD_CHARACTER = /^[a-z0-9_]$/i;

function getVisibleText(value) {
    return String(value ?? '')
        .replace(ZERO_WIDTH_CHARACTERS, '')
        .replace(THINK_BLOCKS, '');
}

function normalizeForMatching(value) {
    return value
        .replace(/[\u2018\u2019]/g, '\'')
        .replace(/\s+/g, ' ')
        .trim();
}

function isAsciiWordCharacter(character) {
    return character !== undefined && ASCII_WORD_CHARACTER.test(character);
}

function matchesLiteralKeyword(normalizedText, keyword) {
    const normalizedKeyword = keyword.toLowerCase();
    let index = normalizedText.indexOf(normalizedKeyword);

    while (index !== -1) {
        const end = index + normalizedKeyword.length;
        const hasLeftBoundary = !isAsciiWordCharacter(normalizedKeyword[0])
            || !isAsciiWordCharacter(normalizedText[index - 1]);
        const hasRightBoundary = !isAsciiWordCharacter(normalizedKeyword[normalizedKeyword.length - 1])
            || !isAsciiWordCharacter(normalizedText[end]);

        if (hasLeftBoundary && hasRightBoundary) {
            return true;
        }

        index = normalizedText.indexOf(normalizedKeyword, index + 1);
    }

    return false;
}

function getKeywordLines(keywords) {
    if (typeof keywords !== 'string') {
        return [];
    }

    return keywords
        .split(/\r\n?|\n/)
        .map(line => normalizeForMatching(line))
        .filter(Boolean);
}

export function detectFailure(text, {
    retryEmpty = true,
    retryApology = true,
    keywords = DEFAULT_KEYWORDS,
    totalText = text,
} = {}) {
    const visibleText = getVisibleText(text);
    const normalizedVisibleText = normalizeForMatching(visibleText);

    if (retryEmpty && (!normalizedVisibleText || normalizedVisibleText === '...')) {
        return { kind: 'empty' };
    }

    if (!retryApology) {
        return null;
    }

    const normalizedVisibleTotal = getVisibleText(totalText);
    if (Array.from(normalizedVisibleTotal).length >= APOLOGY_MAX_LENGTH) {
        return null;
    }

    const normalizedText = normalizeForMatching(visibleText).toLowerCase();
    for (const keyword of getKeywordLines(keywords)) {
        if (matchesLiteralKeyword(normalizedText, keyword)) {
            return { kind: 'apology', keyword };
        }
    }

    return null;
}
