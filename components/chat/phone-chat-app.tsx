"use client";

import { memo, useState, useEffect, useRef } from "react";
import { ChatContactsList } from "./chat-contacts-list";
import { MomentsFeed } from "./moments-feed";
import { ChatRoom } from "./chat-room";
import { MascotChatRoom } from "./mascot-chat-room";
import { UserProfilePanel } from "./user-profile-panel";
import { ChatSession, loadChatSessions, pushChatMessage, hydrateChatStorage } from "@/lib/chat-storage";
import { notifyMascotPageContext } from "@/lib/mascot-events";
import { loadCharacters } from "@/lib/character-storage";
import { scopeSessionCSS } from "@/lib/css-scoper";
import { kvGet } from "@/lib/kv-db";
import { formatXiaohongshuShareForPrompt, type ChatSharePayload } from "@/lib/chat-share";
import { CHAT_OPEN_SESSION_EVENT, CHAT_OPEN_ADD_CONTACT_EVENT } from "@/lib/chat-notification-events";
import { getMascotSettingsSnapshot } from "@/lib/mascot-settings";

type TabKey = "messages" | "contacts" | "feeds" | "me";

export type PhoneChatAppProps = {
    onClose: () => void;
    initialSessionId?: string | null;
    onSessionChange?: (session: ChatSession | null) => void;
    sharePayload?: ChatSharePayload | null;
    onShareDone?: () => void;
};

export const PhoneChatApp = memo(function PhoneChatApp({ onClose, initialSessionId, onSessionChange, sharePayload, onShareDone }: PhoneChatAppProps) {
    const [activeTab, setActiveTab] = useState<TabKey>("messages");
    const [activeSession, setActiveSession] = useState<ChatSession | null>(null);
    const [activeMascot, setActiveMascot] = useState(false);
    const [chatAppCSS, setChatAppCSS] = useState(() => typeof window !== "undefined" ? kvGet("chat-app-custom-css") || "" : "");
    const [visitedSessions, setVisitedSessions] = useState<Map<string, ChatSession>>(new Map());
    const [dbReady, setDbReady] = useState(false);
    const [hideTabBar, setHideTabBar] = useState(false);
    const [sessions, setSessions] = useState<ChatSession[]>([]);
    
    const [isSearchActive, setIsSearchActive] = useState(false);
    const [showAddMenu, setShowAddMenu] = useState(false);

    const [pendingAddContactId, setPendingAddContactId] = useState<string | null>(null);
    const addContactReturnSessionRef = useRef<string | null>(null);
    const activeSessionIdRef = useRef<string | null>(null);
    activeSessionIdRef.current = activeSession?.id ?? null;

    useEffect(() => {
        hydrateChatStorage().then(() => {
            setDbReady(true);
            setSessions(loadChatSessions());
            if (initialSessionId) {
                const s = loadChatSessions().find(s => s.id === initialSessionId);
                if (s) setActiveSession(s);
            }
        });
    }, []);

    // 当会话更新时刷新列表
    useEffect(() => {
        if (dbReady) setSessions(loadChatSessions());
    }, [activeSession, activeTab, dbReady]);

    const prevInitSessionId = useRef(initialSessionId);
    useEffect(() => {
        if (initialSessionId === prevInitSessionId.current) return;
        prevInitSessionId.current = initialSessionId;
        if (!dbReady) return;
        if (!initialSessionId) { setActiveSession(null); return; }
        const s = loadChatSessions().find(s => s.id === initialSessionId);
        if (s) setActiveSession(s);
    }, [initialSessionId, dbReady]);

    useEffect(() => {
        if (sharePayload) {
            setActiveSession(null);
            setActiveMascot(false);
            setActiveTab("contacts");
        }
    }, [sharePayload]);

    useEffect(() => {
        const handler = (e: Event) => {
            const sessionId = (e as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
            if (!sessionId) return;
            const session = loadChatSessions().find(s => s.id === sessionId);
            if (!session) return;
            setActiveMascot(false);
            setActiveSession(session);
            setActiveTab("messages");
        };
        window.addEventListener(CHAT_OPEN_SESSION_EVENT, handler);
        return () => window.removeEventListener(CHAT_OPEN_SESSION_EVENT, handler);
    }, []);

    useEffect(() => {
        const handler = (e: Event) => {
            const characterId = (e as CustomEvent<{ characterId?: string }>).detail?.characterId;
            if (!characterId) return;
            addContactReturnSessionRef.current = activeSessionIdRef.current;
            setActiveSession(null);
            setActiveMascot(false);
            setActiveTab("contacts");
            setPendingAddContactId(characterId);
        };
        window.addEventListener(CHAT_OPEN_ADD_CONTACT_EVENT, handler);
        return () => window.removeEventListener(CHAT_OPEN_ADD_CONTACT_EVENT, handler);
    }, []);

    useEffect(() => {
        onSessionChange?.(activeSession);
        if (activeSession) {
            setActiveMascot(false);
            setVisitedSessions(prev => {
                if (prev.has(activeSession.id)) return prev;
                const next = new Map(prev);
                next.set(activeSession.id, activeSession);
                return next;
            });
            const chars = loadCharacters();
            const char = chars.find(c => c.id === activeSession.contactId);
            notifyMascotPageContext({
                page: "chat", mode: "chatting",
                label: `聊天 · ${(activeSession as Record<string, unknown>).alias as string || char?.name || "对话"}`,
                fields: { sessionId: activeSession.id, contactId: activeSession.contactId },
            });
        }
    }, [activeSession, onSessionChange]);

    const handleSelectContact = (sess: ChatSession | null) => {
        if (sharePayload && sess) { /* ... 省略分享逻辑 ... */ }
        setActiveMascot(false);
        setActiveSession(sess);
        setActiveTab("messages");
    };

    const handleSelectMascot = () => {
        setActiveSession(null);
        setActiveMascot(true);
        setActiveTab("messages");
    };

    const handleAddAction = () => {
        setIsSearchActive(false);
        setShowAddMenu(prev => !prev);
    };

    // 【重点修正】菜单逻辑：移除扫一扫
    const handleMenuItemClick = (action: "group_chat" | "add_friend") => {
        setShowAddMenu(false);
        if (action === "add_friend") {
            addContactReturnSessionRef.current = activeSessionIdRef.current;
            setActiveTab("contacts"); setActiveSession(null); setActiveMascot(false);
            setTimeout(() => window.dispatchEvent(new CustomEvent(CHAT_OPEN_ADD_CONTACT_EVENT, { detail: { characterId: "" } })), 100);
        } else if (action === "group_chat") {
            // 微信原生逻辑：发起聊天和创建群聊都是跳转到通讯录列表
            addContactReturnSessionRef.current = activeSessionIdRef.current;
            setActiveTab("contacts"); setActiveSession(null); setActiveMascot(false);
        }
    };

    useEffect(() => {
        const onCSSUpdate = () => setChatAppCSS(kvGet("chat-app-custom-css") || "");
        window.addEventListener("chat-app-css-updated", onCSSUpdate);
        return () => window.removeEventListener("chat-app-css-updated", onCSSUpdate);
    }, []);

    if (!dbReady) return null;

    return (
        <div className="chat-app absolute inset-0 flex flex-col overflow-hidden z-10 bg-[#FFFFFF] font-sans">
            {chatAppCSS && <style dangerouslySetInnerHTML={{ __html: scopeSessionCSS(chatAppCSS, ".chat-app") }} />}
            
            <div className="chat-main-content relative flex-1 flex flex-col overflow-hidden" {...(activeSession || activeMascot ? { "data-covered-by-room": "" } : {})}>
                
                {activeTab === "messages" && (
                    <div className="relative flex-1 flex flex-col overflow-hidden">
                        <div className="absolute top-0 left-0 right-0 h-[70px] z-30 bg-[#EDEDED] flex items-center justify-between border-b border-[#E5E5E5] px-4 pt-[max(env(safe-area-inset-top,12px),12px)]">
                            <div className="w-8 h-8 cursor-pointer" onClick={onClose}></div>
                            <span className="absolute left-1/2 -translate-x-1/2 font-bold text-[17px] text-[#000000] tracking-wide">微信</span>
                            <div className="flex items-center gap-1 relative">
                                <button onClick={() => { setIsSearchActive(!isSearchActive); setShowAddMenu(false); }} className="w-10 h-10 flex items-center justify-center text-[#181818]">
                                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
                                </button>
                                <div className="relative">
                                    <button onClick={handleAddAction} className="w-10 h-10 flex items-center justify-center text-[#181818]">
                                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
                                    </button>
                                    {/* 真正修复的菜单样式：取消了扫一扫，文字改了 */}
                                    {showAddMenu && (
                                        <div className="absolute top-[calc(100%+8px)] right-0 bg-white rounded-xl shadow-[0_4px_16px_rgba(0,0,0,0.12)] py-1 w-[140px] z-50 border border-[#f0f0f0]">
                                            <button onClick={() => handleMenuItemClick("group_chat")} className="flex items-center gap-3 w-full px-4 py-3 hover:bg-[#f5f5f5] text-[15px] text-[#333]">
                                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                                                发起聊天
                                            </button>
                                            <button onClick={() => handleMenuItemClick("group_chat")} className="flex items-center gap-3 w-full px-4 py-3 hover:bg-[#f5f5f5] text-[15px] text-[#333] border-t border-[#f5f5f5]">
                                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                                                创建群聊
                                            </button>
                                            <button onClick={() => handleMenuItemClick("add_friend")} className="flex items-center gap-3 w-full px-4 py-3 hover:bg-[#f5f5f5] text-[15px] text-[#333] border-t border-[#f5f5f5]">
                                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/><line x1="22" y1="11" x2="22" y2="17"/><line x1="19" y1="14" x2="25" y2="14"/></svg>
                                                添加好友
                                            </button>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* 搜索下拉框 */}
                        {isSearchActive && (
                            <div className="absolute top-[70px] left-0 right-0 z-20 px-4 py-3 bg-[#FFFFFF] border-b border-[#E5E5E5] flex items-center gap-3">
                                <div className="flex-1 bg-[#F4F5F7] rounded-lg px-3 py-1.5 flex items-center gap-2">
                                    <input autoFocus placeholder="搜索" className="w-full bg-transparent outline-none text-[#000] placeholder-[#999] text-[15px]" />
                                </div>
                                <button onClick={() => setIsSearchActive(false)} className="text-[#000] text-[15px] font-medium">取消</button>
                            </div>
                        )}

                        {/* 渲染动态列表 */}
                        <div className="flex-1 overflow-y-auto bg-white pt-[70px]">
                            {/* 预设 AI 助手 */}
                            <div onClick={handleSelectMascot} className="px-4 py-3 flex items-center gap-3 border-b border-[#F5F5F5] cursor-pointer">
                                <div className="w-11 h-11 rounded-xl bg-[#F0F8FF] flex items-center justify-center text-xl border border-[#EBEBEB] flex-shrink-0">🐱</div>
                                <div className="flex-1 flex flex-col min-w-0">
                                    <div className="flex justify-between items-start">
                                        <span className="font-bold text-[16px] text-[#111]">AI助手</span>
                                        <span className="text-[#B2B2B2] text-[11px] flex-shrink-0">AI</span>
                                    </div>
                                    <span className="text-[#999] text-[13px] truncate mt-0.5">随时待命~ 角色卡、预设、世界书、正则、CSS...</span>
                                </div>
                            </div>
                            
                            {/* 动态加载其他会话角色 */}
                            {sessions.filter(s => s.id !== "mascot").map(session => (
                                <div key={session.id} onClick={() => handleSelectContact(session)} className="px-4 py-3 flex items-center gap-3 border-b border-[#F5F5F5] cursor-pointer">
                                    <div className="w-11 h-11 rounded-xl bg-gray-100 flex items-center justify-center text-xl border border-[#EBEBEB] flex-shrink-0">
                                        {session.isGroup ? "👥" : "👤"}
                                    </div>
                                    <div className="flex-1 flex flex-col min-w-0">
                                        <span className="font-bold text-[16px] text-[#111]">{session.alias || session.contactId || "未知角色"}</span>
                                        <span className="text-[#999] text-[13px] truncate mt-0.5">点击开始聊天</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
                
                {activeTab === "contacts" && (
                    <ChatContactsList
                        onCloseApp={onClose}
                        onSelectSession={handleSelectContact}
                        onSelectMascot={handleSelectMascot}
                        pendingAddContactId={pendingAddContactId}
                        onPendingAddContactConsumed={() => setPendingAddContactId(null)}
                        onPendingAddContactBack={() => {
                            const sessionId = addContactReturnSessionRef.current;
                            addContactReturnSessionRef.current = null;
                            if (!sessionId) return;
                            const session = loadChatSessions().find(s => s.id === sessionId);
                            if (!session) return;
                            setActiveSession(session); setActiveTab("messages");
                        }}
                    />
                )}
                {activeTab === "feeds" && <MomentsFeed onCloseApp={onClose} />}
                {activeTab === "me" && <UserProfilePanel onClose={() => setActiveTab("messages")} />}
            </div>

            {/* 底部导航栏 */}
            {!activeSession && !activeMascot && !hideTabBar && (
                <nav className="bg-[#F7F7F7] border-t border-[#D9D9D9] shrink-0 flex justify-around items-center h-[58px]" style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 2px)" }}>
                    <button className="flex flex-col items-center gap-0.5 w-1/4" onClick={() => setActiveTab("messages")}>
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={activeTab === "messages" ? "#07C160" : "#000000"} strokeWidth="1.8"><path d="M8.5 11h.01M12 11h.01M15.5 11h.01M21 12c0 4.97-4.03 9-9 9-1.58 0-3.07-.41-4.37-1.13l-3.66 1.22 1.26-3.54A8.95 8.95 0 0 1 3 12c0-4.97 4.03-9 9-9s9 4.03 9 9z" /></svg>
                        <span className={`text-[10px] font-medium ${activeTab === "messages" ? "text-[#07C160]" : "text-[#888]"}`}>微信</span>
                    </button>
                    <button className="flex flex-col items-center gap-0.5 w-1/4" onClick={() => setActiveTab("contacts")}>
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={activeTab === "contacts" ? "#07C160" : "#000000"} strokeWidth="1.8"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm8 5.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 21v-2a4 4 0 0 0-3-3.87" /></svg>
                        <span className={`text-[10px] font-medium ${activeTab === "contacts" ? "text-[#07C160]" : "text-[#888]"}`}>通讯录</span>
                    </button>
                    <button className="flex flex-col items-center gap-0.5 w-1/4" onClick={() => setActiveTab("feeds")}>
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={activeTab === "feeds" ? "#07C160" : "#000000"} strokeWidth="1.8"><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 18a8 8 0 1 1 8-8 8 8 0 0 1-8 8zm-1-8a1 1 0 1 1 2 0v4a1 1 0 1 1-2 0zm0-4a1 1 0 1 1 2 0 1 1 0 1 1-2 0z" /></svg>
                        <span className={`text-[10px] font-medium ${activeTab === "feeds" ? "text-[#07C160]" : "text-[#888]"}`}>发现</span>
                    </button>
                    <button className="flex flex-col items-center gap-0.5 w-1/4" onClick={() => setActiveTab("me")}>
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={activeTab === "me" ? "#07C160" : "#000000"} strokeWidth="1.8"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" /></svg>
                        <span className={`text-[10px] font-medium ${activeTab === "me" ? "text-[#07C160]" : "text-[#888]"}`}>我</span>
                    </button>
                </nav>
            )}

            {/* 聊天室覆盖层 */}
            {[...visitedSessions.values()].map(sess => (
                <div key={sess.id} style={{ display: activeSession?.id === sess.id ? undefined : 'none' }} className="chat-room-layer absolute inset-0 z-50 bg-white">
                    <ChatRoom session={sess} onBack={() => setActiveSession(null)} />
                </div>
            ))}
            {activeMascot && (
                <div className="chat-room-layer absolute inset-0 z-50 bg-white">
                    <MascotChatRoom onBack={() => setActiveMascot(false)} onDeleted={() => setActiveMascot(false)} />
                </div>
            )}
        </div>
    );
});
