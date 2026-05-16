import { CopilotKit } from '@copilotkit/react-core';
import { CopilotChat } from '@copilotkit/react-ui';
import '@copilotkit/react-ui/styles.css';
import { SERVER_URL } from '../api';

/**
 * CopilotKit chat bound to the Mastra agent through the AG-UI bridge
 * (@ag-ui/mastra `registerCopilotKit` mounted at `${SERVER_URL}/copilotkit`).
 */
export function Chat({ agentId }: { agentId: string }) {
  return (
    <CopilotKit runtimeUrl={`${SERVER_URL}/copilotkit`} agent={agentId}>
      <div className="copilot-host" style={{ height: '100%' }}>
        <CopilotChat
          labels={{
            title: 'Self-Learning Agent',
            initial:
              'Ask me to perform a multi-step DevOps task. When I complete ' +
              'something non-trivial, it is distilled into a reusable skill ' +
              'you will see appear on the left.',
          }}
        />
      </div>
    </CopilotKit>
  );
}
