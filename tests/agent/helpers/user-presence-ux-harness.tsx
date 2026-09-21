import React from 'react';
import {createRoot} from 'react-dom/client';
import {UserPresencePanel} from '../../../app/admin/users/user-presence-panel';
import styles from '../../../app/admin/users/admin-users.module.css';
const forbidden=()=>{};
document.body.style.margin='0';
document.body.style.fontFamily='"Segoe UI","Microsoft YaHei",sans-serif';
createRoot(document.getElementById('root')!).render(<main className={styles.page}><div className={styles.shell}>
 <header className={styles.header}><div className={styles.title}><p>TEAM WORKSPACE</p><h1>用户与使用统计</h1></div><a className={styles.returnLink} href="/">返回主应用</a></header>
 <nav className={styles.managementTabs}><button aria-pressed="true">用户状态</button><button>使用统计</button></nav>
 <UserPresencePanel sessionIdentity={'A'.repeat(43)} onForbidden={forbidden}/>
</div></main>);
